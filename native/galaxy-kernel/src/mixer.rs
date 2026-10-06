//! Galaxy's software mixer on the SSE row of the kernel dispatch, translated
//! from Galaxy.dll (GOTY, preferred base 0x10600000):
//!
//! - the mixing kernel, template 0x10622730 (copied to the code buffer
//!   [0x10698354] by the setup 0x106231d1 and called at 0x106154e0);
//! - the conversion, template 0x10622fe4 (stored at [0x10697ca4]), for the
//!   16-bit stereo store (bus A) and saturating-add (bus B) paths;
//! - the renderer 0x106146a0 over a staging ring, and `render`, its bus-A-only
//!   form for the browser;
//! - the bus clear at the head of the mixer entry 0x10614920
//!   (0x10614976..0x106149f4).
//!
//! Contract: docs/galaxy-music/mixer.md §2.5, §2.6. Verified against the
//! original kernel and renderer under Unicorn and on the host CPU
//! (scripts/native-galaxy-music-sequencer-oracle.py --real-kernel,
//! scripts/validate-galaxy-mixer.mjs).
//!
//! Floating point: the kernel and conversion are SSE float32 under MXCSR
//! 0x1f80 (round to nearest even, no FTZ/DAZ, exceptions masked). Rust f32
//! arithmetic (and Wasm's f32.add/f32.mul/f32.nearest) is IEEE binary32 with
//! the same rounding and denormals, and Rust never contracts a*b+c into an
//! FMA, so every SSE rounding point is reproduced one for one:
//! `cvtpi2ps` (i32 -> f32), `mulps`, `addps`, `cvtps2pi`/`cvtss2si`.
use super::*;
use crate::sequencer::{Region, UNSUPPORTED_READ};

/// Each of the six buses d00 d04 d08 d0c d10 d14 is 0x1040 bytes, 64-byte
/// aligned, carved from [0x10698184] (0x1060e1c8..0x1060e20d).
pub const BUS_BYTES: usize = 0x1040;
const BUS_FLOATS: usize = BUS_BYTES / 4;
/// Bus indices of the two groups: A = music (V+0x11 bit 7), B = everything else.
const GROUP_A: [usize; 3] = [0, 2, 4];
const GROUP_B: [usize; 3] = [1, 3, 5];
/// f32 at 0x1064d2f0 (`00 00 80 30`), the gain scale.
const TWO_M30: f32 = f32::from_bits(0x3080_0000);

// Faults (the original corrupts memory or runs an untranslated path there).
pub const UNSUPPORTED_BUS_WRITE: u32 = 0x120; // the kernel or a conversion would write outside its block
pub const UNSUPPORTED_OUTPUT: u32 = 0x121; // 8-bit output (reads a stale mm5) or an odd ring position
pub const UNSUPPORTED_KERNEL: u32 = 0x122; // the dispatch 0x10614080 would not pick the SSE kernel

/// A kernel read touched a looped sample's allocation tail
/// `[max(Length, LoopEnd + 31), Length + 31)` frames, which the loader never
/// writes (uninitialised in the original, zero here).
pub const HAZARD_UNWRITTEN_TAIL: u32 = 1;
/// A kernel read left the voice's own allocation (the `step & ~1` drift
/// below a loop start at the sample's first frame, or a position the
/// sequencer put outside the sample). The original reads its heap there
/// (block headers, neighbours: platform-dependent); the model reads the
/// neighbouring allocation of the bump-heap address model, or 0 in a
/// block's 16-byte rounding gap, as the oracle with a zeroed heap does.
pub const HAZARD_FOREIGN_READ: u32 = 2;
/// The kernel wrote below d00 (a negative run count moves the bus pointers
/// back, 0x1061557f..0x1061559d): the alignment padding of the bus block,
/// the heap header before it and the non-SSE table block [0x10698344]
/// (0x28000 bytes, GlobalAlloc'd by the call just before the bus block's,
/// 0x1060e1b4; never read by the SSE path). Those writes are dropped; writes
/// that land on the buses are kept (d00 = align64(block), stride 0x1040,
/// 0x1060e1d6..0x1060e20d). That the heap places the two blocks adjacently
/// is what the oracle's allocator does; on Windows it is not measured.
pub const HAZARD_BUS_UNDERRUN: u32 = 4;
/// Bytes below d00 the original can write without leaving the table block.
const BUS_UNDERRUN_LIMIT: i64 = 0x28000;

// Test-only translation mutants (validate-galaxy-mixer.mjs).
pub const MUTANT_FULL_STEP: u32 = 201; // step used without `& ~1`
pub const MUTANT_ROUND_HALF_AWAY: u32 = 202; // conversion rounds half away from zero
pub const MUTANT_F64_ACCUMULATE: u32 = 203; // bus += o * gain in f64, rounded once
pub const MUTANT_NO_SATURATION: u32 = 204; // conversion wraps instead of saturating

/// Bus `ahead` (0x10697cdc) pinned by galaxy_render when the host has set
/// none: one timer callback's steady state is `ahead = D − consumed` before
/// the render, D the ring distance of the two heads. Only zero/nonzero gates
/// the mixer, so the PCM does not depend on the value; this is the installed
/// latency in bytes (Latency 40 ms at 44100 Hz, 16-bit stereo), a host choice.
pub const DEFAULT_AHEAD: u32 = 7056;

pub(crate) struct Mixer {
    /// d00 d04 d08 d0c d10 d14, BUS_FLOATS each.
    pub buses: Vec<f32>,
    pub hazards: u32,
    /// Fabricated memory (validator only): (model address, bytes).
    fab: Vec<(u32, Vec<u8>)>,
    /// galaxy_render's output, reused across calls.
    out: Vec<i16>,
    /// render_ring's staging ring and the direct conversion's destination (validator only).
    ring: Vec<i16>,
    scratch: Vec<i16>,
    /// The six buses after each mixer call of a render, when enabled (validator only).
    bus_log: Option<Vec<f32>>,
}

impl Mixer {
    pub(crate) fn new() -> Self {
        Mixer {
            buses: vec![0.0; 6 * BUS_FLOATS],
            hazards: 0,
            fab: Vec::new(),
            out: Vec::new(),
            ring: Vec::new(),
            scratch: Vec::new(),
            bus_log: None,
        }
    }
}

/// Frames the template stores for count word `dx`: the 16-bit counter's
/// control flow (0x10622889, 0x10622907..0x10622912, 0x10622a01..0x10622a0f,
/// 0x10622a8e). A bus0 that is not 16-byte aligned gets a one-frame `movlps`
/// prologue first, so a count of 0 still stores one frame there; a count word
/// with bit 15 set runs the main loop thousands of times.
fn kernel_frames(count: u32, aligned: bool) -> u32 {
    let mut dx = count as u16;
    let mut n = 0u32;
    if aligned {
        dx = dx.wrapping_sub(4);
    } else {
        n = 1;
        dx = dx.wrapping_sub(5);
    }
    while dx as i16 >= 0 {
        n += 4;
        dx = dx.wrapping_sub(4);
    }
    dx = dx.wrapping_add(3);
    while dx as i16 >= 0 {
        n += 1;
        dx = dx.wrapping_sub(1);
    }
    n
}

/// `cvtps2pi` / `cvtss2si` under MXCSR 0x1f80: round to nearest even; NaN and
/// values outside i32 give the integer indefinite 0x80000000.
fn cvt(x: f32, half_away: bool) -> i32 {
    let r = if half_away { x.round() } else { x.round_ties_even() };
    if (-2147483648.0..2147483648.0).contains(&r) {
        r as i32
    } else {
        i32::MIN
    }
}

/// `packssdw` (signed saturation to 16 bits).
fn sat16(v: i32, wrap: bool) -> i16 {
    if wrap {
        v as i16
    } else {
        v.clamp(-32768, 32767) as i16
    }
}

/// The conversion template 0x10622fe4 `conv(src, frames, dst, fmt)` for the
/// formats it supports here. Mono (`fmt & 1 = 0`) returns at once
/// (0x10622ff3..0x10622ffb). 16-bit stereo: `frames << 1` scalars, blocks of
/// 8 then single scalars, each `sat16(cvt(x))` stored (0x10623180..0x106231ca)
/// or, with `fmt & 0x40`, `sat16(dst + sat16(cvt(x)))` (`paddsw`,
/// 0x1062311e..0x1062317c). Per-scalar results do not depend on the split.
fn convert(src: &[f32], frames: i32, dst: &mut [i16], fmt: u8, half_away: bool, wrap: bool) -> Result<(), u32> {
    if fmt & 1 == 0 {
        return Ok(());
    }
    let scalars = frames.wrapping_shl(1);
    if scalars <= 0 {
        return Ok(()); // ZF from `shl`, or the negative count skips both loops
    }
    if fmt & 2 == 0 {
        // 8-bit output: `paddb mm5` adds a stale register unless fmt & 0x80.
        return Err(UNSUPPORTED_OUTPUT);
    }
    let n = scalars as usize;
    if n > src.len() {
        return Err(UNSUPPORTED_READ);
    }
    if n > dst.len() {
        return Err(UNSUPPORTED_BUS_WRITE);
    }
    if fmt & 0x40 != 0 {
        for (d, &x) in dst[..n].iter_mut().zip(&src[..n]) {
            let v = sat16(cvt(x, half_away), wrap) as i32;
            *d = sat16(*d as i32 + v, wrap);
        }
    } else {
        for (d, &x) in dst[..n].iter_mut().zip(&src[..n]) {
            *d = sat16(cvt(x, half_away), wrap);
        }
    }
    Ok(())
}

/// A readable block of the model's memory.
struct View<'a> {
    base: u32,
    bytes: &'a [u8],
    tail: (u32, u32), // byte offsets of a never-written looped-sample tail
}

/// The model memory the kernel reads samples from: the player's live
/// allocations (instruments, sample data, pattern blocks, by model address)
/// and fabricated blocks. `own` is the allocation of the run's first read.
struct Memory<'a> {
    regions: &'a [(u32, u32, Region)],
    instruments: &'a [Option<Instrument>],
    patterns: &'a [Option<Pattern>],
    fab: &'a [(u32, Vec<u8>)],
    own: Option<View<'a>>,
    hazards: u32,
}

impl<'a> Memory<'a> {
    fn locate(&self, a: u32) -> Option<View<'a>> {
        for (base, bytes) in self.fab {
            if (a.wrapping_sub(*base) as usize) < bytes.len() {
                return Some(View { base: *base, bytes, tail: (0, 0) });
            }
        }
        let i = self.regions.partition_point(|r| r.0 <= a);
        if i == 0 {
            return None;
        }
        let (start, len, region) = self.regions[i - 1];
        if a - start >= len {
            return None;
        }
        let (bytes, tail): (&'a [u8], (u32, u32)) = match region {
            Region::Instrument(s) => (&self.instruments[s as usize].as_ref()?.bytes, (0, 0)),
            Region::Sample(s, k) => {
                let ins = self.instruments[s as usize].as_ref()?;
                let data = ins.data[k as usize].as_ref()?;
                // The record at 0x14a + 0x48k (it-loader §4): Type +0x2c, Length +0x30, LoopEnd +0x38.
                let at = 0x14a + 0x48 * k as usize;
                let kind = get16(&ins.bytes, at + 0x2c);
                let length = get32(&ins.bytes, at + 0x30) as u64;
                let loop_end = get32(&ins.bytes, at + 0x38) as u64;
                let bps = if kind & 4 != 0 { 2 } else { 1 };
                let tail = if kind & 8 != 0 {
                    let lo = length.max(loop_end + 31) * bps;
                    let hi = (length + 31) * bps;
                    (lo.min(u32::MAX as u64) as u32, hi.min(u32::MAX as u64) as u32)
                } else {
                    (0, 0)
                };
                (data, tail)
            }
            Region::PatternHeader(p) => (&self.patterns[p as usize].as_ref()?.header[..], (0, 0)),
            Region::Events(p) => (&self.patterns[p as usize].as_ref()?.events, (0, 0)),
        };
        Some(View { base: start, bytes, tail })
    }

    /// `width` bytes at model address `a`, little-endian, sign-extended.
    fn read(&mut self, a: u32, width: u32) -> Result<i32, u32> {
        if self.own.is_none() {
            self.own = self.locate(a);
        }
        if let Some(v) = &self.own {
            let off = a.wrapping_sub(v.base);
            if (off as u64) + width as u64 <= v.bytes.len() as u64 {
                if off < v.tail.1 && off + width > v.tail.0 {
                    self.hazards |= HAZARD_UNWRITTEN_TAIL;
                }
                let o = off as usize;
                return Ok(if width == 2 {
                    i16::from_le_bytes([v.bytes[o], v.bytes[o + 1]]) as i32
                } else {
                    v.bytes[o] as i8 as i32
                });
            }
        }
        self.hazards |= HAZARD_FOREIGN_READ;
        let lo = self.foreign_byte(a)?;
        Ok(if width == 2 {
            i16::from_le_bytes([lo, self.foreign_byte(a.wrapping_add(1))?]) as i32
        } else {
            lo as i8 as i32
        })
    }

    /// A byte outside the run's allocation: another allocation's, or 0 in a
    /// heap block's rounding gap (blocks are 16-byte rounded); anything else
    /// is memory the model does not have.
    fn foreign_byte(&self, a: u32) -> Result<u8, u32> {
        if let Some(v) = self.locate(a) {
            return Ok(v.bytes[(a - v.base) as usize]);
        }
        let i = self.regions.partition_point(|r| r.0 <= a);
        if i > 0 {
            let (start, len, _) = self.regions[i - 1];
            if ((a - start) as u64) < ((len as u64 + 15) & !15) && a - start >= len {
                return Ok(0);
            }
        }
        Err(UNSUPPORTED_READ)
    }
}

impl Library {
    /// The dispatch 0x10614080 picks the SSE template for MMX & SSE & stereo.
    fn check_kernel(&self) -> Result<(), u32> {
        let [mmx, sse, _] = self.player.cpu;
        if mmx == 0 || sse == 0 || self.player.output_format & 1 == 0 {
            Err(UNSUPPORTED_KERNEL)
        } else {
            Ok(())
        }
    }

    /// 0x10614976..0x106149f4: `n << shift` bytes of all six buses zeroed.
    pub(crate) fn clear_buses(&mut self, n: i32, bus_shift: u32) {
        if n <= 0 {
            return;
        }
        let floats = (((n as usize) << bus_shift) / 4).min(BUS_FLOATS);
        for b in 0..6 {
            self.player.mixer.buses[b * BUS_FLOATS..b * BUS_FLOATS + floats].fill(0.0);
        }
    }

    /// The SSE mixing kernel (template 0x10622730) for one run, as the mixer
    /// calls it at 0x106154e0: the bus group's three buses at byte `offset`,
    /// `args` = count, position, fraction, step, then the gain words
    /// L, R, s1L, s1R, s2L, s2R (kernel args 7..12) and the mode bits.
    ///
    /// Per stored frame k (§2.5): `t = (frac & 0xfffe) + k·(step & ~1)`,
    /// position `pos + (t >> 16)`, weight `w = (t & 0xffff) >> 1`,
    /// `o = x[p+1]·w + x[p]·(32767 − w)` (`pmaddwd`; 8-bit samples are the
    /// signed byte `<< 8`), then for each bus lane `bus += f32(o) · gain`
    /// with `gain = (s16)word · 2^-30`. Mode bit 2 negates the R words first
    /// (0x10622734..0x10622742). The 4-frame pipeline, the `movlps` prologue
    /// and the tail store exactly these values in frame order; the two
    /// prefetched frames past the end are read and dropped (not modelled).
    pub(crate) fn mix_kernel(&mut self, music: bool, offset: i32, args: &[u32; 11]) -> Result<(), u32> {
        self.check_kernel()?;
        let mode = args[10];
        let mut g = [args[4], args[5], args[6], args[7], args[8], args[9]];
        if mode & 4 != 0 {
            for j in [1, 3, 5] {
                g[j] = (g[j] & 0xffff_0000) | (g[j] as u16).wrapping_neg() as u32;
            }
        }
        let gains = g.map(|x| (x as u16 as i16 as f32) * TWO_M30);
        let frac = (args[2] as u16 & 0xfffe) as i64;
        let step = if self.mutant(MUTANT_FULL_STEP) { args[3] } else { args[3] & !1 } as i32 as i64;
        let pos = args[1];
        let wide = mode & 1 != 0;
        let f64_acc = self.mutant(MUTANT_F64_ACCUMULATE);
        // The buses are 64-byte aligned, so `test edi, 0xf` sees the offset.
        let n = kernel_frames(args[0], offset & 0xf == 0) as i64;
        let group = if music { GROUP_A } else { GROUP_B };
        // Byte addresses relative to d00 of each bus's first frame. The six
        // buses are one block at stride 0x1040; a run whose offset went
        // negative (or past a bus) writes into the neighbouring buses exactly
        // as the original does. Past d14 lies the code buffer (the next
        // GlobalAlloc): the original overwrites its own kernel there.
        let rel = group.map(|b| (b * BUS_BYTES) as i64 + offset as i64);
        if n > 0 {
            let lowest = rel.iter().min().unwrap();
            let highest = rel.iter().max().unwrap() + 8 * n;
            if offset & 7 != 0 || highest > (6 * BUS_BYTES) as i64 || *lowest < -BUS_UNDERRUN_LIMIT {
                return Err(UNSUPPORTED_BUS_WRITE);
            }
        }
        let player = &mut self.player;
        let mut mem = Memory {
            regions: &player.regions,
            instruments: &self.instruments,
            patterns: &self.patterns,
            fab: &player.mixer.fab,
            own: None,
            hazards: 0,
        };
        let buses = &mut player.mixer.buses;
        let mut underrun = false;
        for k in 0..n {
            let t = frac + k * step;
            let p = (pos as i64).wrapping_add(t >> 16) as u32;
            let w = ((t & 0xffff) >> 1) as i32;
            let (a, b) = if wide {
                let at = p.wrapping_mul(2);
                (mem.read(at, 2)?, mem.read(at.wrapping_add(2), 2)?)
            } else {
                (mem.read(p, 1)? << 8, mem.read(p.wrapping_add(1), 1)? << 8)
            };
            let o = b.wrapping_mul(w).wrapping_add(a.wrapping_mul(32767 - w));
            let fo = o as f32;
            // Frame by frame in order: the original's 2-frame groups read all
            // three buses before storing them, but a group's buses are 0x2080
            // bytes (1040 frames) apart, so an overlapping write is always one
            // of an earlier frame, which the in-order loop sees as it does.
            for (j, &r) in rel.iter().enumerate() {
                let byte = r + 8 * k;
                if byte < 0 {
                    underrun = true;
                    continue;
                }
                let at = (byte / 4) as usize;
                for lane in 0..2 {
                    let gain = gains[2 * j + lane];
                    let x = &mut buses[at + lane];
                    *x = if f64_acc { (*x as f64 + fo as f64 * gain as f64) as f32 } else { *x + fo * gain };
                }
            }
        }
        let hazards = mem.hazards | if underrun { HAZARD_BUS_UNDERRUN } else { 0 };
        self.player.mixer.hazards |= hazards;
        Ok(())
    }

    /// The conversion of bus `bus` from frame `first`, `frames` frames, into `dst`.
    fn convert_bus(&mut self, bus: usize, first: usize, frames: i32, dst: &mut [i16], fmt: u8) -> Result<(), u32> {
        let half_away = self.mutant(MUTANT_ROUND_HALF_AWAY);
        let wrap = self.mutant(MUTANT_NO_SATURATION);
        let start = bus * BUS_FLOATS + 2 * first;
        let src = &self.player.mixer.buses[start.min(bus * BUS_FLOATS + BUS_FLOATS)..bus * BUS_FLOATS + BUS_FLOATS];
        convert(src, frames, dst, fmt, half_away, wrap)
    }

    fn log_buses(&mut self) {
        let m = &mut self.player.mixer;
        if let Some(log) = m.bus_log.as_mut() {
            log.extend_from_slice(&m.buses);
        }
    }

    fn trace_words(&mut self, tag: u8, words: &[u32]) {
        if let Some(t) = self.player.trace.as_mut() {
            t.buf.push(tag);
            t.buf.extend_from_slice(&(4 * words.len() as u32).to_le_bytes());
            for w in words {
                t.buf.extend_from_slice(&w.to_le_bytes());
            }
        }
    }

    /// One conversion pair of the renderer (0x1061480a..0x106148ba): `k`
    /// frames of `bus` at ring byte `pos`, the part past the ring's end
    /// wrapped to its start.
    fn convert_ring(&mut self, ring: &mut [i16], bus: usize, k: i32, pos: i32, fmt: u8, shift: u32) -> Result<(), u32> {
        let size = (ring.len() * 2) as i32;
        let n1 = ((size - pos) >> shift).min(k);
        if pos < 0 || pos & 1 != 0 || pos > size {
            return Err(UNSUPPORTED_OUTPUT);
        }
        self.convert_bus(bus, 0, n1, &mut ring[(pos / 2) as usize..], fmt)?;
        self.convert_bus(bus, n1.max(0) as usize, k - n1, ring, fmt)
    }

    /// The renderer 0x106146a0(ring, size, posA, posB, lenA, lenB): mixer
    /// calls of n = min(framesA, framesB) frames (clamped to 512 by the
    /// mixer) while both lengths and `ahead` are nonzero; after each, the
    /// effect hooks (null for DX: the music units are never installed and
    /// the effects reverb is not translated), bus A converted with the
    /// output format (store) at posA and bus B with `fmt | 0x40` (saturating
    /// add) at posB, both wrapping at the ring's end. Returns bytes.
    pub fn render_ring(&mut self, ring: &mut [i16], pos_a: i32, pos_b: i32, len_a: i32, len_b: i32) -> Result<i32, u32> {
        self.check_kernel()?;
        let fmt = self.player.output_format;
        let shift = ((fmt & 1) + ((fmt >> 1) & 1)) as u32;
        let size = (ring.len() * 2) as i32;
        let (mut fa, mut fb) = (len_a >> shift, len_b >> shift);
        let (mut pa, mut pb) = (pos_a, pos_b);
        let mut total = 0i32;
        if fa == 0 || size == 0 {
            return Ok(0);
        }
        loop {
            if fb == 0 || self.player.ahead == 0 {
                break;
            }
            let n = if fa < fb { fa } else { fb };
            self.trace_words(b'M', &[n as u32]);
            let k = self.mix(n)?;
            self.trace_words(b'R', &[k as u32]);
            self.log_buses();
            self.convert_ring(ring, 0, k, pa, fmt, shift)?;
            self.convert_ring(ring, 1, k, pb, fmt | 0x40, shift)?;
            let bytes = k << shift;
            pa = pa.wrapping_add(bytes) % size;
            pb = pb.wrapping_add(bytes) % size;
            fa -= k;
            fb -= k;
            total = total.wrapping_add(bytes);
            if fa == 0 {
                break;
            }
        }
        Ok(total)
    }

    /// 0x106146a0 for one request of `frames` frames, bus A only: the mixer
    /// calls and their order are the renderer's, bus A (d00, the music) is
    /// converted with the output format into `out` as interleaved stereo
    /// int16. Bus B's saturating add into the ring is not produced (the
    /// browser plays effects on Web Audio). Returns the frames rendered,
    /// fewer than `frames` only when `ahead` is zero. No allocation.
    pub fn render(&mut self, frames: i32, out: &mut [i16]) -> Result<i32, u32> {
        self.check_kernel()?;
        let fmt = self.player.output_format;
        if fmt & 3 != 3 {
            return Err(UNSUPPORTED_OUTPUT);
        }
        if frames < 0 || out.len() < 2 * frames as usize {
            return Err(UNSUPPORTED_BUS_WRITE);
        }
        let mut done = 0i32;
        while done < frames {
            if self.player.ahead == 0 {
                break;
            }
            self.trace_words(b'M', &[(frames - done) as u32]);
            let k = self.mix(frames - done)?;
            self.trace_words(b'R', &[k as u32]);
            self.log_buses();
            self.convert_bus(0, 0, k, &mut out[2 * done as usize..], fmt)?;
            done += k;
        }
        Ok(done)
    }

    /// Validator: a model global by its original address.
    fn poke(&mut self, address: u32, value: u32) -> bool {
        match address {
            0x10698348 => self.channels = value as u8,
            0x10698349 => self.playing = value as u8,
            0x1068828d => self.first_music_voice = value as u8,
            0x10697cf0 => self.music_master = value as u8,
            0x1069817c => self.player.sfx_master = value as u8,
            0x10697cdc => self.player.ahead = value,
            _ => return false,
        }
        true
    }
}

// ---- Wasm exports -------------------------------------------------------------

fn with_library<R>(f: impl FnOnce(&mut Library) -> R) -> R {
    LIBRARY.with(|l| f(&mut l.borrow_mut()))
}

/// One render request of `frames` frames for the browser: `ahead` is pinned
/// (galaxy_seq_ahead's value, else DEFAULT_AHEAD) as a timer callback's
/// steady state leaves it, then `render`. Returns 2*frames interleaved int16
/// (left, right), valid until the next call, or 0 on a fault (galaxy_fault).
#[no_mangle]
pub extern "C" fn galaxy_render(frames: u32) -> *const i16 {
    with_library(|l| {
        if l.player.fault != 0 || frames > i32::MAX as u32 / 2 {
            return std::ptr::null();
        }
        let mut out = std::mem::take(&mut l.player.mixer.out);
        let n = 2 * frames as usize;
        if out.len() != n {
            out.resize(n, 0); // allocates only when the request grows
        }
        l.player.ahead = if l.player.ahead_pin != 0 { l.player.ahead_pin } else { DEFAULT_AHEAD };
        let result = l.render(frames as i32, &mut out);
        let ptr = out.as_ptr();
        if let Ok(done) = result {
            out[2 * done as usize..].fill(0);
        }
        l.player.mixer.out = out;
        match result {
            Ok(_) => ptr,
            Err(e) => {
                l.player.fault = e;
                std::ptr::null()
            }
        }
    })
}

/// The fault that stopped the player (0 = none); cleared by galaxy_reset.
#[no_mangle]
pub extern "C" fn galaxy_fault() -> u32 {
    with_library(|l| l.player.fault)
}

/// Mixer hazards since the last reset (HAZARD_UNWRITTEN_TAIL).
#[no_mangle]
pub extern "C" fn galaxy_mixer_hazards() -> u32 {
    with_library(|l| l.player.mixer.hazards)
}

// Validator-only exports.

/// The six buses d00 d04 d08 d0c d10 d14 (BUS_BYTES / 4 floats each).
#[no_mangle]
pub extern "C" fn galaxy_mixer_buses() -> *mut f32 {
    with_library(|l| l.player.mixer.buses.as_mut_ptr())
}

/// The raw voice table (256 x 0xa0 bytes at the model of 0x1068dca0).
#[no_mangle]
pub extern "C" fn galaxy_voices_ptr() -> *mut u8 {
    with_library(|l| l.voices.as_mut_ptr())
}

/// A zeroed fabricated memory block of `len` bytes at model address `address`.
#[no_mangle]
pub extern "C" fn galaxy_mixer_memory(address: u32, len: u32) -> *mut u8 {
    with_library(|l| {
        let fab = &mut l.player.mixer.fab;
        fab.retain(|(a, _)| *a != address);
        fab.push((address, vec![0; len as usize]));
        fab.last_mut().unwrap().1.as_mut_ptr()
    })
}

/// A model global by its original address; 1 if known.
#[no_mangle]
pub extern "C" fn galaxy_poke(address: u32, value: u32) -> u32 {
    with_library(|l| l.poke(address, value) as u32)
}

/// One direct kernel call on bus group A (music != 0) or B; 0 or a fault.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn galaxy_mixer_kernel(music: u32, offset: u32, count: u32, pos: u32, frac: u32, step: u32,
    l: u32, r: u32, s1l: u32, s1r: u32, s2l: u32, s2r: u32, mode: u32) -> u32 {
    with_library(|lib| {
        match lib.mix_kernel(music != 0, offset as i32, &[count, pos, frac, step, l, r, s1l, s1r, s2l, s2r, mode]) {
            Ok(()) => 0,
            Err(e) => e,
        }
    })
}

/// The direct conversion's destination (`samples` int16, zeroed).
#[no_mangle]
pub extern "C" fn galaxy_mixer_scratch(samples: u32) -> *mut i16 {
    with_library(|l| {
        let s = &mut l.player.mixer.scratch;
        s.clear();
        s.resize(samples as usize, 0);
        s.as_mut_ptr()
    })
}

/// conv(bus + 8·first, frames, scratch, fmt); 0 or a fault.
#[no_mangle]
pub extern "C" fn galaxy_mixer_convert(bus: u32, first: u32, frames: u32, fmt: u32) -> u32 {
    with_library(|l| {
        let mut dst = std::mem::take(&mut l.player.mixer.scratch);
        let r = l.convert_bus(bus as usize % 6, first as usize, frames as i32, &mut dst, fmt as u8);
        l.player.mixer.scratch = dst;
        match r {
            Ok(()) => 0,
            Err(e) => e,
        }
    })
}

/// The staging ring for galaxy_render_ring (`bytes` long, zeroed).
#[no_mangle]
pub extern "C" fn galaxy_mixer_ring(bytes: u32) -> *mut i16 {
    with_library(|l| {
        let r = &mut l.player.mixer.ring;
        r.clear();
        r.resize(bytes as usize / 2, 0);
        r.as_mut_ptr()
    })
}

/// The renderer on the staging ring; returns its byte count (0 and
/// galaxy_fault set on a fault). `ahead` is not pinned here.
#[no_mangle]
pub extern "C" fn galaxy_render_ring(pos_a: u32, pos_b: u32, len_a: u32, len_b: u32) -> u32 {
    with_library(|l| {
        if l.player.fault != 0 {
            return 0;
        }
        let mut ring = std::mem::take(&mut l.player.mixer.ring);
        let r = l.render_ring(&mut ring, pos_a as i32, pos_b as i32, len_a as i32, len_b as i32);
        l.player.mixer.ring = ring;
        match r {
            Ok(bytes) => bytes as u32,
            Err(e) => {
                l.player.fault = e;
                0
            }
        }
    })
}

/// Start (1) or stop (0) logging the six buses after each render's mixer call.
#[no_mangle]
pub extern "C" fn galaxy_mixer_bus_log(enable: u32) {
    with_library(|l| l.player.mixer.bus_log = if enable != 0 { Some(Vec::new()) } else { None });
}

#[no_mangle]
pub extern "C" fn galaxy_mixer_bus_log_ptr() -> *const f32 {
    with_library(|l| l.player.mixer.bus_log.as_ref().map_or(std::ptr::null(), |v| v.as_ptr()))
}

#[no_mangle]
pub extern "C" fn galaxy_mixer_bus_log_len() -> u32 {
    with_library(|l| l.player.mixer.bus_log.as_ref().map_or(0, |v| v.len() as u32))
}

/// Pin `ahead` (0x10697cdc) now (the callback pin applies at each callback).
#[no_mangle]
pub extern "C" fn galaxy_mixer_ahead_now() {
    with_library(|l| l.player.ahead = l.player.ahead_pin);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Hand-computed frames: `cvtpi2ps` rounds an odd o above 2^24 to even,
    /// the product rounds once, the lanes and surround negation, the gain word
    /// sign-extended from the low 16 bits.
    #[test]
    fn kernel_by_hand() {
        let mut l = Library::new(16);
        assert_eq!(l.setup_output(64, [1, 1, 0], 44100, 2, 16, 7), OK);
        let base = 0x5000_0000u32;
        let mut data = vec![0u8; 64];
        for f in 0..32 {
            data[2 * f..2 * f + 2].copy_from_slice(&513i16.to_le_bytes());
        }
        l.player.mixer.fab.push((base, data));
        // frac 2 -> w = 1: o = 513 * 1 + 513 * 32766 = 16809471, f32 16809472 (tie to even).
        let gain_r = 0xdead_0003u32; // low word 3
        l.mix_kernel(true, 0, &[1, base / 2, 3, 0x10000, 7, gain_r, 0, 0, 0, 0, 1]).unwrap();
        let two30 = 2f64.powi(30);
        let lane0 = ((16809472.0f64 * 7.0) / two30) as f32;
        let lane1 = ((16809472.0f64 * 3.0) / two30) as f32;
        assert_eq!(l.player.mixer.buses[0], lane0);
        assert_eq!(l.player.mixer.buses[1], lane1);
        assert_eq!(l.player.mixer.buses[2], 0.0); // one frame only (aligned, count 1)
        // Surround (mode bit 2) negates the R word: the second lane subtracts.
        l.mix_kernel(true, 0, &[1, base / 2, 3, 0x10000, 7, gain_r, 0, 0, 0, 0, 5]).unwrap();
        assert_eq!(l.player.mixer.buses[1], lane1 + -lane1);
        // Odd offset, count 0: the prologue still stores one frame (frac 0: o = 513 * 32767).
        l.mix_kernel(false, 8, &[0, base / 2, 0, 0x10000, 0x8000, 0, 0, 0, 0, 0, 1]).unwrap();
        let d04 = BUS_FLOATS;
        assert_eq!(l.player.mixer.buses[d04 + 2], ((16809472.0f64 * -32768.0) / two30) as f32);
        assert_eq!(l.player.mixer.buses[d04 + 3], 0.0);
    }

    #[test]
    fn frame_counts() {
        for n in 0..600u32 {
            assert_eq!(kernel_frames(n, true), n);
            assert_eq!(kernel_frames(n, false), n.max(1));
        }
        assert_eq!(kernel_frames(0xffff, true), 0);
        assert_eq!(kernel_frames(0xffff, false), 1);
        assert!(kernel_frames(0x8003, true) > 0x7000);
    }

    #[test]
    fn conversion_edges() {
        assert_eq!(cvt(0.5, false), 0);
        assert_eq!(cvt(1.5, false), 2);
        assert_eq!(cvt(2.5, false), 2);
        assert_eq!(cvt(-0.5, false), 0);
        assert_eq!(cvt(-1.5, false), -2);
        assert_eq!(cvt(2.5, true), 3);
        assert_eq!(cvt(f32::NAN, false), i32::MIN);
        assert_eq!(cvt(2147483648.0, false), i32::MIN);
        assert_eq!(cvt(-2147483648.0, false), i32::MIN);
        assert_eq!(cvt(2147483520.0, false), 2147483520);
        assert_eq!(cvt(f32::from_bits(1), false), 0);
        assert_eq!(sat16(cvt(32767.5, false), false), 32767);
        assert_eq!(sat16(cvt(-32768.5, false), false), -32768);
        assert_eq!(sat16(cvt(1e10, false), false), -32768); // indefinite, then saturated
    }
}
