//! Galaxy.dll music library state and its module loader, translated from the
//! hash-pinned GOTY `System/Galaxy.dll` (preferred base 0x10600000). See
//! docs/galaxy-music.md ("Loader: implemented") and
//! docs/galaxy-music/it-loader.md for the address-anchored contract; every
//! function below names the original it translates. The loader is integer
//! only. Verified byte for byte against the original running under Unicorn
//! (scripts/native-galaxy-music-oracle.py, scripts/validate-galaxy-music-loader.mjs).
//!
//! Galaxy keeps one song in globals; `Library` owns the same state: the song
//! scalars, name, order list, initial pan, the IT loader's private statics
//! (one contiguous block, so table overruns land where the original's do),
//! the 256 voice records (raw original layout), and the instrument and pattern
//! slots (raw original layouts, pointers replaced by ownership).
//!
//! Only the Impulse Tracker branch of `glxLoadMusic` is translated (all 35 DX
//! songs are IT). Where the original would read or write outside one of its
//! allocations the kernel stops with an UNSUPPORTED_* status instead of
//! guessing; the library state is then partial, as the original's is after an
//! error return.
use std::cell::RefCell;

// glxLoadMusic results (GALAXY.H GLXERR_* numbering, as returned by the DLL).
pub const OK: u32 = 0;
pub const ALREADY_LOADED: u32 = 1; // 0x10618bfc
pub const MUSIC_PLAYING: u32 = 2; // 0x1060e970
pub const DAMAGED_FILE: u32 = 0x10; // 0x1062fbab (short sample read)
// Kernel-only results: the original would leave its allocations here.
pub const UNSUPPORTED_FORMAT: u32 = 0x101; // a non-IT loader of the dispatcher
pub const UNSUPPORTED_TABLE: u32 = 0x102; // offset tables / slots past their storage
pub const UNSUPPORTED_PATTERN: u32 = 0x103; // packed > 0xe000, events > 0xc101, Rows 0, cursor past 0xe008
pub const UNSUPPORTED_SAMPLE: u32 = 0x104; // sample size overflow, padding outside the data
pub const UNSUPPORTED_CODING: u32 = 0x105; // delta/stereo conversion (never set by the IT loader)

// Hazards: inputs whose original result depends on memory the original never
// initialised. None occurs for the 35 DX songs (oracle-measured).
pub const HAZARD_SLACK_READ: u32 = 1; // a stream read copied the caller's 1024-byte slack
pub const HAZARD_SHORT_READ: u32 = 2; // a short read left a destination partly stale
pub const HAZARD_PATTERN_OVERREAD: u32 = 4; // the row parser passed this pattern's packed bytes
pub const HAZARD_UNINIT_INSTRUMENT: u32 = 8; // sample mode without 'IMPS': bytes 0x14a..0x191 uninitialised
pub const HAZARD_SHORT_HEADER: u32 = 0x10; // fewer than 0x30 bytes for the dispatcher's peek
// Not a hazard of the load itself: the tail [max(LoopEnd+31, Length), Length+31)
// of a looped sample's allocation is never written (uninitialised in the
// original, zero here). Whether the mixer can read it is a mixer question.
pub const INFO_UNWRITTEN_SAMPLE_TAIL: u32 = 0x100;

const SLACK: u32 = 0x400; // Update's FArray::Add(0x400) before the load (0x1060a702..0x1060a735)
const MARK: u32 = 0xffff_ffff; // a set pointer field (allocation-independent)

const INST: u32 = 0x5453_4e49;
const SAMP: u32 = 0x504d_4153;
const PATT: u32 = 0x5454_4150;
const TRAK: u32 = 0x4b41_5254;
const VOIC: u32 = 0x4349_4f56;

// The IT loader's statics 0x106841a8..0x10684e28, referenced by no other code.
const SCRATCH: usize = 0xc80;
const LASTCMDVAL: usize = 0x106841a8 - 0x106841a8;
const LASTINS: usize = 0x106841e8 - 0x106841a8;
const LASTMASK: usize = 0x10684228 - 0x106841a8;
const INSOFF: usize = 0x10684268 - 0x106841a8;
const LASTVOL: usize = 0x10684468 - 0x106841a8;
const REMAP: usize = 0x106844a8 - 0x106841a8;
const PATOFF: usize = 0x106845a8 - 0x106841a8;
const LASTCMD: usize = 0x106849a8 - 0x106841a8;
const LASTNOTE: usize = 0x106849e8 - 0x106841a8;
const SMPOFF: usize = 0x10684a28 - 0x106841a8;

const VOICES: usize = 0x100;
const VOICE: usize = 0xa0; // records at 0x1068dca0

// Test-only translation mutants (validate-galaxy-music-loader.mjs): 0 = none.
pub const MUTANT_NO_FADE_IN: u32 = 1;
pub const MUTANT_PADDING_30: u32 = 2;
pub const MUTANT_D_FINE_SWAP: u32 = 3;
pub const MUTANT_NOTE_CUT_KEEPS_VOLUME: u32 = 4;
pub const MUTANT_EFFECT_MEMORY_PER_PATTERN: u32 = 5;
pub const MUTANT_CLEAR_ORDER_TAIL: u32 = 6;
pub const MUTANT_S9X_RAW: u32 = 7;
pub const MUTANT_VOLUME_CLAMP_DWORD: u32 = 8;

fn get16(b: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([b[o], b[o + 1]])
}
fn get32(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}
fn put16(b: &mut [u8], o: usize, v: u16) {
    b[o..o + 2].copy_from_slice(&v.to_le_bytes());
}
fn put32(b: &mut [u8], o: usize, v: u32) {
    b[o..o + 4].copy_from_slice(&v.to_le_bytes());
}

/// `glxInstrument` (0x14a header) followed by `glxSample[Samples]` (0x48
/// each), exactly as allocated; `data[n]` is sample n's Data allocation.
struct Instrument {
    bytes: Vec<u8>,
    data: Vec<Option<Vec<u8>>>,
}

/// `glxPattern` with its single `glxTrack`; `events` is Track[0].Events.
struct Pattern {
    header: [u8; 0x28],
    events: Vec<u8>,
}

/// The memory stream 0x10618aa0/0x10618b10/0x10618bd0 over glxMemory{Data, Length, DataPos}.
struct Stream<'a> {
    data: &'a [u8], // module bytes followed by the slack
    length: u32,
    module: u32,
    pos: u32,
    log: Vec<(u8, u32, u32, u32)>,
    hazards: u32,
}

impl Stream<'_> {
    /// 0x10618aa0: whence 0 set, 1 relative, 2 from Length; unsigned clamp to Length.
    fn seek(&mut self, offset: u32, whence: u32) -> u32 {
        self.log.push((1, offset, whence, self.pos));
        let pos = match whence {
            0 => offset,
            1 => self.pos.wrapping_add(offset),
            2 => self.length.wrapping_add(offset),
            _ => return 1,
        };
        self.pos = if pos > self.length { self.length } else { pos };
        0
    }

    /// 0x10618b10, fread semantics: a short read copies whole items only.
    fn read(&mut self, dst: &mut [u8], size: u32, count: u32) -> Result<u32, u32> {
        self.log.push((2, size, count, self.pos));
        let mut count = count;
        let avail = self.length - self.pos;
        if avail < size.wrapping_mul(count) {
            count = avail / size;
            self.hazards |= HAZARD_SHORT_READ;
        }
        let bytes = size.wrapping_mul(count) as usize;
        if bytes > dst.len() {
            return Err(UNSUPPORTED_TABLE);
        }
        let start = self.pos as usize;
        dst[..bytes].copy_from_slice(&self.data[start..start + bytes]);
        if bytes > 0 && start + bytes > self.module as usize {
            self.hazards |= HAZARD_SLACK_READ;
        }
        self.pos += bytes as u32;
        Ok(count)
    }

    /// 0x10618bd0.
    fn tell(&mut self) -> u32 {
        self.log.push((3, 0, 0, self.pos));
        self.pos
    }
}

/// The 0xc101-byte event buffer (`1 + 256*(1 + 32*6)`).
struct Events {
    ev: Vec<u8>,
    e: usize,
}

impl Events {
    fn put(&mut self, v: u8) -> Result<(), u32> {
        if self.e >= self.ev.len() {
            return Err(UNSUPPORTED_PATTERN); // the original overruns its heap block
        }
        self.ev[self.e] = v;
        self.e += 1;
        Ok(())
    }
}

/// The packed-pattern cursor over the 0xe008 scratch buffer.
struct Packed<'a> {
    pb: &'a [u8],
    cur: usize,
    end: usize,
    overread: bool,
}

impl Packed<'_> {
    fn peek(&mut self) -> Result<u8, u32> {
        if self.cur >= self.pb.len() {
            return Err(UNSUPPORTED_PATTERN);
        }
        if self.cur >= self.end {
            self.overread = true;
        }
        Ok(self.pb[self.cur])
    }
    fn next(&mut self) -> Result<u8, u32> {
        let b = self.peek()?;
        self.cur += 1;
        Ok(b)
    }
}

pub struct Library {
    channels: u8,          // 0x10698348: highest channel + 1; nonzero = loaded
    playing: u8,           // 0x10698349
    song_length: u8,       // 0x1069834a, base zero
    music_master: u8,      // 0x10697cf0 (the IT loader stores GV here)
    initial_speed: u16,    // 0x10697cea
    initial_tempo: u16,    // 0x1069817e
    player_mode: u8,       // 0x10697ce8
    min_period: u16,       // 0x106886a6
    max_period: u16,       // 0x10698180
    r10698208: u32,        // reset scalars, named by address until the player names them
    r10697ce6: u16,
    r10698141: u8,
    r10697ca8: u8,
    tempo: u16,            // 0x10698188
    speed: u16,            // 0x10698342
    order_position: u8,    // 0x10698201
    r10698140: u8,
    r10698200: u8,
    first_music_voice: u8, // 0x1068828d = EffectsChannels
    song_name: [u8; 32],   // 0x106981e0
    orders: [u8; 256],     // 0x10698220
    initial_pan: [u8; 256], // 0x106886c0
    scratch: Vec<u8>,      // 0x106841a8..0x10684e28
    voices: Vec<u8>,       // 0x1068dca0, 256 x 0xa0
    instruments: Vec<Option<Instrument>>, // 0x106882a0 [2][128]
    patterns: Vec<Option<Pattern>>,       // 0x10697d40 [256]
    hazards: u32,
    alloc_log: Vec<(u8, u32)>,
    stream_log: Vec<(u8, u32, u32, u32)>,
    mutant: u32,
}

impl Library {
    /// glxInit's state section (0x1060dfff..0x1060e1b2) for the fields the
    /// loader reads or writes, then the subsystem Init's 0x1060ebc0(EffectsChannels)
    /// (0x106056df).
    pub fn new(effects_channels: u8) -> Self {
        let mut voices = vec![0u8; VOICES * VOICE];
        for v in voices.chunks_mut(VOICE) {
            put32(v, 0, VOIC);
            put32(v, 4, 0x98);
            v[0xd] = 0;
            put16(v, 0x1c, 0);
            put16(v, 0x1e, 0x7f);
            v[0xc] = 0xbc;
            v[0x41] = 0x7f;
            v[0x3f] = 0x7f;
            v[0x11] = 8;
            put16(v, 0x12, 0x7e02);
            put16(v, 0x1a, 0x7fff);
            put16(v, 0x16, 0x4000);
            put16(v, 0x14, 0x4000);
        }
        let mut library = Library {
            channels: 0,
            playing: 0,
            song_length: 0,
            music_master: 0x7f,
            initial_speed: 0x30,
            initial_tempo: 0x78,
            player_mode: 0,
            min_period: 0,
            max_period: 0x7800,
            r10698208: 0,
            r10697ce6: 0,
            r10698141: 0xff,
            r10697ca8: 0,
            tempo: 0x78,
            speed: 0x30,
            order_position: 0xff,
            r10698140: 1,
            r10698200: 1,
            first_music_voice: 8,
            song_name: [0; 32],
            orders: [0; 256],
            initial_pan: [0x40; 256],
            scratch: vec![0; SCRATCH],
            voices,
            instruments: (0..256).map(|_| None).collect(),
            patterns: (0..256).map(|_| None).collect(),
            hazards: 0,
            alloc_log: Vec::new(),
            stream_log: Vec::new(),
            mutant: 0,
        };
        library.set_sample_channels(effects_channels as u32);
        library
    }

    /// 0x1060ebc0 (the gate on 0x10698394, never set here, is omitted).
    fn set_sample_channels(&mut self, count: u32) -> u32 {
        if self.channels as u32 + count > 0x100 {
            return 0;
        }
        self.first_music_voice = count as u8;
        for v in 0..count as usize {
            self.voices[v * VOICE + 0x10] = 1;
        }
        1
    }

    fn mutant(&self, id: u32) -> bool {
        self.mutant == id
    }

    fn malloc(&mut self, size: u32) {
        self.alloc_log.push((1, size));
    }
    fn realloc(&mut self, size: u32) {
        self.alloc_log.push((2, size));
    }
    fn free(&mut self, size: u32) {
        self.alloc_log.push((3, size));
    }

    /// 0x1060e850, the reset glxLoadMusic calls first.
    fn reset_music(&mut self) -> u32 {
        if self.playing != 0 {
            return MUSIC_PLAYING;
        }
        for i in self.first_music_voice as usize..VOICES {
            let v = &mut self.voices[i * VOICE..(i + 1) * VOICE];
            v.fill(0);
            v[0xd] = 0;
            put16(v, 0x1c, 0);
            put16(v, 0x1e, 0x28);
            v[0x41] = 0x64;
            v[0x3f] = 0x64;
            put16(v, 0x12, 0x4e20);
            put16(v, 0x1a, 0x7fff);
            put16(v, 0x16, 0x4000);
            put16(v, 0x14, 0x4000);
            v[0xc] = 0xbc;
        }
        self.r10698208 = 0;
        self.r10697ce6 = 0;
        self.r10698141 = 0xff;
        self.r10697ca8 = 0;
        self.tempo = 0x78;
        self.speed = 0x30;
        self.order_position = 0xff;
        self.r10698140 = 1;
        self.song_length = 0;
        self.music_master = 0x7f;
        self.initial_speed = 0x30;
        self.initial_tempo = 0x78;
        self.r10698200 = 1;
        self.player_mode = 0;
        self.min_period = 0;
        self.max_period = 0x7800;
        OK
    }

    /// glxLoadMusic 0x10618be0 with Flags = GLX_LOADFROMMEMORY (2), the only
    /// caller's flags (0x1060a77e). `input` holds the module bytes followed
    /// by the caller's slack; `module` is the module length.
    pub fn load_music(&mut self, input: &[u8], module: u32) -> u32 {
        self.hazards = 0; // hazards describe the latest load
        if self.channels != 0 {
            return ALREADY_LOADED;
        }
        let reset = self.reset_music();
        if reset == MUSIC_PLAYING {
            return reset;
        }
        let mut s = Stream {
            data: input,
            length: module.wrapping_add(SLACK),
            module,
            pos: 0,
            log: Vec::new(),
            hazards: 0,
        };
        // 0x10618c82..0x10618c97: peek 0x30 bytes, seek back.
        let mut peek = [0u8; 0x30];
        let got = match s.read(&mut peek, 1, 0x30) {
            Ok(n) => n,
            Err(e) => return e,
        };
        if got < 0x30 {
            s.hazards |= HAZARD_SHORT_HEADER;
        }
        s.seek(0u32.wrapping_sub(0x30), 1);
        let result = if &peek[0..4] == b"MThd" || &peek[0..3] == b"MTM" || &peek[0..4] == b"FAR\xfe" {
            UNSUPPORTED_FORMAT
        } else if &peek[0..4] == b"IMPM" {
            self.load_it(&mut s)
        } else {
            UNSUPPORTED_FORMAT // RIFF AM, S3M, PTM, ULT, XM, 669, STM, MOD
        };
        self.hazards |= s.hazards;
        self.stream_log.extend_from_slice(&s.log);
        result
    }

    /// The IT loader 0x10628990.
    fn load_it(&mut self, s: &mut Stream) -> u32 {
        match self.load_it_inner(s) {
            Ok(status) | Err(status) => status,
        }
    }

    fn load_it_inner(&mut self, s: &mut Stream) -> Result<u32, u32> {
        self.malloc(0xc0);
        let mut hdr = vec![0u8; 0xc0];
        self.malloc(0x226);
        let mut ib = vec![0u8; 0x226];
        self.malloc(0x50);
        let mut smp = vec![0u8; 0x50];
        self.malloc(0xe008);
        let mut pb = vec![0u8; 0xe008];
        let base = s.tell();
        s.read(&mut hdr, 1, 0xc0)?;
        self.song_name[..0x1a].copy_from_slice(&hdr[4..0x1e]);
        self.scratch[PATOFF..PATOFF + 0x400].fill(0);
        // 0x10628a6e..0x10628a83: GV, with a clamp a movsx byte can never take.
        self.music_master = hdr[0x30];
        if (self.music_master as i8 as i32) > 0x7f {
            self.music_master = 0x7f;
        }
        self.initial_speed = hdr[0x32] as u16;
        self.initial_tempo = hdr[0x33] as u16;
        let ordnum = get16(&hdr, 0x20) as u32;
        self.song_length = if ordnum > 0xff { 0xff } else { ordnum as u8 };
        let n = self.song_length as u32;
        s.read(&mut self.orders, 1, n)?;
        if self.mutant(MUTANT_CLEAR_ORDER_TAIL) {
            self.orders[n as usize..].fill(0);
        }
        s.seek(ordnum.wrapping_sub(n), 1);
        let insnum = get16(&hdr, 0x22) as u32;
        let smpnum = get16(&hdr, 0x24) as u32;
        let patnum = get16(&hdr, 0x26) as u32;
        s.read(&mut self.scratch[INSOFF..], 4, insnum)?;
        s.read(&mut self.scratch[SMPOFF..], 4, smpnum)?;
        s.read(&mut self.scratch[PATOFF..], 4, patnum)?;
        for i in 0..0x20 {
            let v = hdr[0x40 + i];
            self.initial_pan[i] = if v as u32 <= 0x40 {
                let p = v.wrapping_shl(1);
                if p > 0x7f { 0x7f } else { p }
            } else {
                0xa0
            };
        }
        // 0x10628bd5..0x10628c20: the first 0xff ends the song (index 0x100 if none).
        let mut i = 0u32;
        while i < 0x100 && self.orders[i as usize] != 0xff {
            i += 1;
        }
        if (i as i32) < self.song_length as i32 {
            self.song_length = i as u8;
        }
        self.song_length = self.song_length.wrapping_sub(1);

        if get16(&hdr, 0x2c) & 4 != 0 {
            // Instrument mode 0x10628c3a.
            for i in 0..insnum as usize {
                if i >= 0x100 {
                    return Err(UNSUPPORTED_TABLE);
                }
                let off = base.wrapping_add(get32(&self.scratch, INSOFF + 4 * i));
                s.seek(off, 0);
                s.read(&mut ib, 1, 0x226)?;
                self.malloc(0x14a);
                let mut bytes = vec![0u8; 0x14a];
                put32(&mut bytes, 0, INST);
                put32(&mut bytes, 4, 0x142);
                bytes[9] = i as u8;
                bytes[0xa..0x24].copy_from_slice(&ib[0x20..0x3a]);
                self.instruments[i] = Some(Instrument { bytes, data: Vec::new() });
                if &ib[0..4] != b"IMPI" {
                    continue;
                }
                let status = self.load_instrument(i, &mut ib, &mut smp, base, s)?;
                if status != OK {
                    return Ok(status);
                }
            }
        } else {
            // Sample mode 0x106295ec.
            for i in 0..smpnum as usize {
                if i >= 0x100 {
                    return Err(UNSUPPORTED_TABLE);
                }
                let off = base.wrapping_add(get32(&self.scratch, SMPOFF + 4 * i));
                s.seek(off, 0);
                s.read(&mut smp, 1, 0x50)?;
                self.malloc(0x192);
                let mut bytes = vec![0u8; 0x192];
                put32(&mut bytes, 0, INST);
                put32(&mut bytes, 4, 0x142);
                bytes[9] = i as u8;
                bytes[0xa..0x24].copy_from_slice(&smp[0x14..0x2e]);
                if &smp[0..4] != b"IMPS" {
                    self.hazards |= HAZARD_UNINIT_INSTRUMENT;
                    self.instruments[i] = Some(Instrument { bytes, data: Vec::new() });
                    continue;
                }
                bytes[0x14a..0x192].fill(0);
                put16(&mut bytes, 0x148, 1);
                bytes[0x2a..0xaa].fill(0);
                bytes[0x152..0x16c].copy_from_slice(&smp[0x14..0x2e]);
                convert_sample(&mut bytes, 0x14a, &smp, self.mutant);
                self.instruments[i] = Some(Instrument { bytes, data: vec![None] });
                s.seek(base.wrapping_add(get32(&smp, 0x48)), 0);
                let status = self.load_sample(i, 0, s)?;
                if status != OK {
                    return Ok(status);
                }
            }
        }

        self.convert_patterns(&mut pb, base, s)?;

        // 0x1062a30f..0x1062a37d.
        self.player_mode = ((((get16(&hdr, 0x2c) & 8) >> 3) ^ 1) | 2) as u8;
        self.channels = self.channels.wrapping_add(1);
        self.min_period = 0x1c5;
        self.max_period = 0xff00;
        self.free(0xc0);
        self.free(0x226);
        self.free(0x50);
        self.free(0xe008);
        Ok(OK)
    }

    /// Instrument mode, one IMPI past its signature (0x10628d47..0x106295dd).
    fn load_instrument(
        &mut self,
        i: usize,
        ib: &mut [u8],
        smp: &mut [u8],
        base: u32,
        s: &mut Stream,
    ) -> Result<u32, u32> {
        ib[0x1e] = 0;
        self.scratch[REMAP..REMAP + 0x100].fill(0);
        {
            let ins = &mut self.instruments[i].as_mut().unwrap().bytes;
            for k in 0..0x78 {
                let sn = ib[0x41 + 2 * k] as usize;
                if sn == 0 {
                    continue;
                }
                if self.scratch[REMAP + sn - 1] == 0 {
                    self.scratch[REMAP + sn - 1] = ib[0x1e].wrapping_add(1);
                    ib[0x1e] = ib[0x1e].wrapping_add(1);
                }
                ins[0x2a + k] = self.scratch[REMAP + sn - 1].wrapping_sub(1);
            }
            for j in 0..10 {
                put16(ins, 0xbe + 4 * j, get16(ib, 0x137 + 3 * j));
                let t = (ib[0x136 + 3 * j] as i32) << 9;
                put16(ins, 0xc0 + 4 * j, if t > 0x7fff { 0x7fff } else { t as u16 });
            }
            let fade = ((get16(ib, 0x14) as u32) << 5) as u16;
            put16(ins, 0xe6, if fade > 0x7fff { 0x7fff } else { fade });
            for j in 0..10 {
                put16(ins, 0xee + 4 * j, get16(ib, 0x1db + 3 * j));
                let t = (ib[0x1da + 3 * j] as i8 as i32) << 7;
                put16(ins, 0xf0 + 4 * j, if t > 0x7fff { 0x7fff } else { t as u16 });
            }
            for j in 0..10 {
                put16(ins, 0x11e + 4 * j, get16(ib, 0x189 + 3 * j));
                let t = (ib[0x188 + 3 * j] as i8 as i32) << 10;
                put16(ins, 0x120 + 4 * j, if t > 0x7fff { 0x7fff } else { t as u16 });
            }
            let flag = |f: u8| (f & 1) | ((f & 2) << 1) | ((f & 4) >> 1);
            ins[0xb8] = flag(ib[0x130]);
            ins[0xba] = ib[0x131] & 0xf;
            ins[0xbb] = ib[0x134] & 0xf;
            ins[0xbc] = ib[0x132] & 0xf;
            ins[0xbd] = ib[0x133] & 0xf;
            // The sustain bit comes from the pan envelope's flags (0x106290e2).
            ins[0xe8] = (ib[0x1d4] & 1) | ((ib[0x1d4] & 2) << 1) | ((ib[0x182] & 4) >> 1);
            ins[0xea] = ib[0x1d5] & 0xf;
            ins[0xeb] = ib[0x1d9] & 0xf;
            ins[0xec] = ib[0x1d6] & 0xf;
            ins[0xed] = ib[0x1d7] & 0xf;
            ins[0x118] = flag(ib[0x182]);
            ins[0x11a] = ib[0x183] & 0xf;
            ins[0x11b] = ib[0x187] & 0xf;
            ins[0x11c] = ib[0x184] & 0xf;
            ins[0x11d] = ib[0x185] & 0xf;
        }
        let size = 0x14a + ib[0x1e] as usize * 0x48;
        self.realloc(size as u32);
        {
            let ins = self.instruments[i].as_mut().unwrap();
            ins.bytes.resize(size, 0);
            ins.data = (0..ib[0x1e]).map(|_| None).collect();
        }
        for n in 0..ib[0x1e] as usize {
            // The smallest remap index holding n+1; always found (values 1..NoS).
            let mut j = 0usize;
            while self.scratch[REMAP + j] as usize != n + 1 {
                j += 1;
            }
            s.seek(base.wrapping_add(get32(&self.scratch, SMPOFF + 4 * j)), 0);
            s.read(smp, 1, 0x50)?;
            let at = 0x14a + n * 0x48;
            {
                let ins = &mut self.instruments[i].as_mut().unwrap().bytes;
                ins[at..at + 0x48].fill(0);
                let count = get16(ins, 0x148).wrapping_add(1);
                put16(ins, 0x148, count);
                ins[at + 8..at + 8 + 0x16].copy_from_slice(&smp[0x14..0x2a]);
                if get32(smp, 0x30) == 0 {
                    continue;
                }
                convert_sample(ins, at, smp, self.mutant);
            }
            s.seek(base.wrapping_add(get32(smp, 0x48)), 0);
            let status = self.load_sample(i, n, s)?;
            if status != OK {
                return Ok(status);
            }
        }
        Ok(OK)
    }

    /// The shared sample-data loader 0x1062fb10, for the IT loader's samples.
    fn load_sample(&mut self, slot: usize, n: usize, s: &mut Stream) -> Result<u32, u32> {
        let at = 0x14a + n * 0x48;
        let ins = &mut self.instruments[slot].as_mut().unwrap().bytes;
        let mut kind = get16(ins, at + 0x2c);
        let bps: u32 = if kind & 4 != 0 { 2 } else { 1 };
        if kind & 8 == 0 {
            kind &= 0xe7;
            put16(ins, at + 0x2c, kind);
        }
        if get16(ins, at + 0x2a) > 0x7fff {
            put16(ins, at + 0x2a, 0x7fff);
        }
        let length = get32(ins, at + 0x30);
        if get32(ins, at + 0x38) > length {
            put32(ins, at + 0x38, length);
        }
        if get32(ins, at + 0x38) == get32(ins, at + 0x34) {
            let k = get16(ins, at + 0x2c) & 0xe7;
            put16(ins, at + 0x2c, k);
        }
        if length == 0 {
            return Ok(OK);
        }
        let frames = length.checked_add(0x1f).ok_or(UNSUPPORTED_SAMPLE)?;
        let size = frames.checked_mul(bps).ok_or(UNSUPPORTED_SAMPLE)?;
        if size > 0x1000_0000 {
            return Err(UNSUPPORTED_SAMPLE);
        }
        self.alloc_log.push((1, size));
        let mut data = vec![0u8; size as usize];
        let ins = &mut self.instruments[slot].as_mut().unwrap();
        put32(&mut ins.bytes, at + 0x44, MARK);
        let got = s.read(&mut data, bps, length)?;
        if got != length {
            ins.data[n] = Some(data);
            return Ok(DAMAGED_FILE);
        }
        let b = &mut ins.bytes;
        put32(b, at, SAMP);
        put32(b, at + 4, 0x40);
        let kind = get16(b, at + 0x2c);
        if kind & 0x43 != 0 {
            if kind & 0x41 != 0 {
                // Stereo de-interleave and delta decoding: no IT sample sets
                // these Type bits (0x106297f0..0x10629894).
                ins.data[n] = Some(data);
                return Err(UNSUPPORTED_CODING);
            }
            // Unsigned to signed (0x1062fc7d..0x1062fce8), then 0x1062fcf0.
            for f in 0..length as usize {
                if bps == 2 {
                    let w = u16::from_le_bytes([data[2 * f], data[2 * f + 1]]).wrapping_add(0x8000);
                    data[2 * f..2 * f + 2].copy_from_slice(&w.to_le_bytes());
                } else {
                    data[f] = data[f].wrapping_add(0x80);
                }
            }
            let reserved = get16(b, at + 0x2e);
            if reserved & 1 == 0 {
                put16(b, at + 0x2c, kind & 0xfffc);
                put16(b, at + 0x2e, reserved | 0x80);
            }
        }
        // Padding 0x1062fd04..0x1062fdd5, then the fade-in 0x1062fdd7..0x1062fe16.
        let kind = get16(b, at + 0x2c);
        let loop_start = get32(b, at + 0x34) as u64;
        let loop_end = get32(b, at + 0x38) as u64;
        let frames = frames as u64;
        let pad = if self.mutant == MUTANT_PADDING_30 { 30 } else { 31 };
        let rd = |d: &[u8], f: u64| -> i32 {
            if bps == 2 {
                i16::from_le_bytes([d[2 * f as usize], d[2 * f as usize + 1]]) as i32
            } else {
                d[f as usize] as i8 as i32
            }
        };
        let wr = |d: &mut [u8], f: u64, v: i32| {
            if bps == 2 {
                d[2 * f as usize..2 * f as usize + 2].copy_from_slice(&(v as i16).to_le_bytes());
            } else {
                d[f as usize] = v as u8;
            }
        };
        if kind & 8 != 0 {
            if kind & 0x10 != 0 {
                if loop_end < 31 {
                    ins.data[n] = Some(data);
                    return Err(UNSUPPORTED_SAMPLE); // would read before Data
                }
                for k in 0..pad {
                    let v = rd(&data, loop_end - k - 1);
                    wr(&mut data, loop_end + k, v);
                }
            } else {
                if loop_start + 30 >= frames {
                    ins.data[n] = Some(data);
                    return Err(UNSUPPORTED_SAMPLE); // would read past Data
                }
                for k in 0..pad {
                    let v = rd(&data, loop_start + k);
                    wr(&mut data, loop_end + k, v);
                }
            }
            if loop_end < length as u64 {
                self.hazards |= INFO_UNWRITTEN_SAMPLE_TAIL;
            }
        } else {
            let last = rd(&data, length as u64 - 1);
            for k in 0..pad {
                wr(&mut data, length as u64 + k, last * (32 - k as i32) / 32);
            }
        }
        if self.mutant != MUTANT_NO_FADE_IN {
            for c in 0..32u64 {
                let v = rd(&data, c);
                wr(&mut data, c, v * c as i32 / 32);
            }
        }
        ins.data[n] = Some(data);
        Ok(OK)
    }

    /// 0x1062995c..0x1062a30a: each pattern converted once, at its first
    /// appearance in the order list; the converter state is zeroed once per load.
    fn convert_patterns(&mut self, pb: &mut [u8], base: u32, s: &mut Stream) -> Result<(), u32> {
        for at in [LASTNOTE, LASTCMD, LASTCMDVAL, LASTINS, LASTVOL, LASTMASK] {
            self.scratch[at..at + 0x40].fill(0);
        }
        for o in 0..self.song_length as usize + 1 {
            let p = self.orders[o] as usize;
            if p >= 0xfe || self.patterns[p].is_some() || get32(&self.scratch, PATOFF + 4 * p) == 0 {
                continue;
            }
            if self.mutant(MUTANT_EFFECT_MEMORY_PER_PATTERN) {
                for at in [LASTNOTE, LASTCMD, LASTCMDVAL, LASTINS, LASTVOL, LASTMASK] {
                    self.scratch[at..at + 0x40].fill(0);
                }
            }
            self.malloc(0x28);
            let mut header = [0u8; 0x28];
            put32(&mut header, 0, PATT);
            put32(&mut header, 4, 0x1e);
            put32(&mut header, 8, 1);
            put32(&mut header, 0xc, TRAK);
            put32(&mut header, 0x10, 0x14);
            put32(&mut header, 0x24, MARK);
            self.malloc(0xc101);
            self.patterns[p] = Some(Pattern { header, events: Vec::new() });
            s.seek(base.wrapping_add(get32(&self.scratch, PATOFF + 4 * p)), 0);
            s.read(&mut pb[..8], 1, 8)?;
            let packed = get16(pb, 0) as u32;
            let got = s.read(&mut pb[8..], 1, packed)?;
            let rows = get16(pb, 2) as u32;
            if rows == 0 {
                return Err(UNSUPPORTED_PATTERN); // rowsLeft = -1: 2^32 rows
            }
            let events = self.convert_pattern(pb, 8 + got as usize, rows)?;
            self.realloc(events.len() as u32);
            self.patterns[p].as_mut().unwrap().events = events;
        }
        Ok(())
    }

    /// One pattern's rows (0x10629b37..0x1062a2cf), into Galaxy's event stream.
    fn convert_pattern(&mut self, pb: &[u8], packed_end: usize, rows: u32) -> Result<Vec<u8>, u32> {
        let mut out = Events { ev: vec![0u8; 0xc101], e: 0 };
        let mut packed = Packed { pb, cur: 8, end: packed_end, overread: false };
        let mut rows_left = rows.wrapping_sub(1);
        out.put(rows_left as u8)?;
        let sc = &mut self.scratch;
        let mutant = self.mutant;
        let mut channels = self.channels;
        loop {
            if packed.peek()? == 0 {
                packed.cur += 1;
                out.put(0)?;
                let t = rows_left;
                rows_left = rows_left.wrapping_sub(1);
                if t == 0 {
                    break;
                }
                continue;
            }
            let (mut note, mut ins, mut cmd, mut val, mut vol) = (0u8, 0u8, 0u8, 0u8, 0xffu8);
            let cv = packed.next()?;
            let ch = ((cv as u32).wrapping_sub(1) & 0x3f) as usize;
            let mask = if cv & 0x80 != 0 { packed.next()? } else { sc[LASTMASK + ch] };
            sc[LASTMASK + ch] = mask;
            if mask & 1 != 0 {
                note = packed.next()?;
                if note < 0x78 {
                    note += 1;
                }
                if note == 0xfe {
                    if mutant != MUTANT_NOTE_CUT_KEEPS_VOLUME {
                        vol = 0;
                    }
                    note = 0;
                }
                if note == 0xff {
                    note = 0x80;
                }
                sc[LASTNOTE + ch] = note;
            }
            if mask & 2 != 0 {
                ins = packed.next()?;
                sc[LASTINS + ch] = ins;
            }
            if mask & 4 != 0 {
                let mut v = packed.next()?;
                if v <= 0x40 {
                    v = v.wrapping_shl(1);
                    if v > 0x7f {
                        v = 0x7f;
                    }
                    vol &= v;
                }
                sc[LASTVOL + ch] = v;
            }
            if mask & 8 != 0 {
                cmd = packed.next()?;
                sc[LASTCMD + ch] = cmd;
                val = packed.next()?;
                if !(cmd == 1 || cmd == 0xb || cmd == 0xc || (4..=6).contains(&cmd)) {
                    sc[LASTCMDVAL + ch] = val;
                }
            }
            if mask & 0x10 != 0 {
                note = sc[LASTNOTE + ch];
            }
            if mask & 0x20 != 0 {
                ins = sc[LASTINS + ch];
            }
            if mask & 0x40 != 0 {
                let v = sc[LASTVOL + ch];
                if v <= 0x7f {
                    vol &= v;
                }
            }
            if mask & 0x80 != 0 {
                cmd = sc[LASTCMD + ch];
                val = sc[LASTCMDVAL + ch];
            }
            // Effect translation, jump table 0x1062a385 on cmd-1 (A..X). A, D,
            // E, F, K and L take 00 from the channel's single parameter slot
            // and write theirs back.
            let recall = |sc: &mut [u8], val: &mut u8| {
                if *val == 0 {
                    *val = sc[LASTCMDVAL + ch];
                }
                sc[LASTCMDVAL + ch] = *val;
            };
            match cmd {
                1 => {
                    recall(sc, &mut val);
                    if val > 0x20 {
                        val = 0x20;
                    }
                    cmd = 0xf;
                }
                2 => cmd = 0xb,
                3 => cmd = 0xd,
                4 => {
                    recall(sc, &mut val);
                    if val & 0xf == 0xf && val & 0xf0 != 0 {
                        cmd = 0xe;
                        val = (val >> 4) | if mutant == MUTANT_D_FINE_SWAP { 0xb0 } else { 0xa0 };
                    } else if val >= 0xf1 {
                        cmd = 0xe;
                        val = (val & 0xf) | if mutant == MUTANT_D_FINE_SWAP { 0xa0 } else { 0xb0 };
                    } else {
                        cmd = 0xa;
                        if val & 0xf != 0 {
                            val &= 0xf;
                        }
                    }
                }
                5 | 6 => {
                    recall(sc, &mut val);
                    let fine = if cmd == 5 { 0x20 } else { 0x10 };
                    if val >= 0xf0 {
                        val = (val & 0xf) | fine;
                        cmd = 0xe;
                    } else if val >= 0xe0 {
                        val = (((val & 0xf) + 2) >> 2) | fine;
                        cmd = 0xe;
                    } else {
                        cmd = if cmd == 5 { 2 } else { 1 };
                    }
                }
                7 => cmd = 3,
                8 => cmd = 4,
                10 => cmd = 0,
                11 => {
                    recall(sc, &mut val);
                    cmd = 6;
                }
                12 => {
                    recall(sc, &mut val);
                    cmd = 5;
                }
                15 => cmd = 9,
                17 => {
                    cmd = 0xe;
                    val = (val & 0xf) | 0x90;
                }
                18 => cmd = 7,
                19 => {
                    // Sub-table 0x1062a415 -> 0x1062a3e5 on val & 0xf0.
                    cmd = 0xe;
                    match val & 0xf0 {
                        0x00 | 0x80 | 0xc0 | 0xd0 | 0xe0 | 0xf0 => {}
                        0x10 => val = (val & 0xf) | 0x30,
                        0x30 => val = (val & 0xf) | 0x40,
                        0x40 => val = (val & 0xf) | 0x70,
                        0x90 => {
                            if mutant != MUTANT_S9X_RAW {
                                cmd = 8;
                                val = 0xa4;
                            }
                        }
                        0xb0 => val = (val & 0xf) | 0x60,
                        _ => {
                            cmd = 0;
                            val = 0;
                        }
                    }
                }
                20 => {
                    if val >= 0x20 {
                        cmd = 0xf;
                    }
                }
                24 => cmd = 8,
                _ => {
                    val = 0;
                    cmd = 0;
                }
            }
            // 0x1062a18a..0x1062a29e.
            let head = out.e;
            out.put(ch as u8)?;
            if cmd != 0 || val != 0 {
                out.put(val)?;
                out.put(cmd)?;
                out.ev[head] |= 0x80;
            }
            if note != 0 || ins != 0 {
                out.put(ins)?;
                out.put(note)?;
                out.ev[head] |= 0x40;
            }
            if vol != 0xff {
                out.put(vol)?;
                out.ev[head] |= 0x20;
            }
            if out.ev[head] & 0xe0 == 0 || ch >= 0x20 {
                out.e = head;
            } else if ch as u8 > channels {
                channels = ch as u8;
            }
        }
        self.channels = channels;
        if packed.overread {
            self.hazards |= HAZARD_PATTERN_OVERREAD;
        }
        out.ev.truncate(out.e);
        Ok(out.ev)
    }

    /// glxUnloadMusic 0x10619450.
    pub fn unload_music(&mut self) -> u32 {
        if self.playing != 0 {
            return MUSIC_PLAYING;
        }
        for p in 0..256 {
            if let Some(pattern) = self.patterns[p].take() {
                self.free(pattern.events.len() as u32);
                self.free(0x28);
            }
        }
        for idx in 0..256 {
            self.unload_instrument(idx);
        }
        self.channels = 0;
        OK
    }

    /// 0x106195b0.
    fn unload_instrument(&mut self, idx: usize) -> u32 {
        let Some(ins) = self.instruments[idx].take() else { return 0x11 };
        if get32(&ins.bytes, 0) != INST {
            self.instruments[idx] = Some(ins);
            return 0x11;
        }
        for v in self.voices.chunks_mut(VOICE) {
            if v[0xd] as usize == idx {
                v[0xf] = 0;
            }
        }
        let samples = get16(&ins.bytes, 0x148) as usize;
        for data in ins.data.iter().take(samples).flatten() {
            self.alloc_log.push((3, data.len() as u32));
        }
        self.free(ins.bytes.len() as u32);
        OK
    }

    /// The comparison dump (format in src/runtime/galaxy-music-loader.mjs).
    pub fn dump(&self, status: u32) -> Vec<u8> {
        let mut out = b"GLXD".to_vec();
        out.extend_from_slice(&1u32.to_le_bytes());
        let mut section = |tag: &[u8; 4], payload: &[u8]| {
            out.extend_from_slice(tag);
            out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
            out.extend_from_slice(payload);
        };
        section(b"STAT", &status.to_le_bytes());
        let mut scal = Vec::new();
        scal.push(self.channels);
        scal.push(self.playing);
        scal.push(self.song_length);
        scal.push(self.music_master);
        scal.extend_from_slice(&self.initial_speed.to_le_bytes());
        scal.extend_from_slice(&self.initial_tempo.to_le_bytes());
        scal.push(self.player_mode);
        scal.extend_from_slice(&self.min_period.to_le_bytes());
        scal.extend_from_slice(&self.max_period.to_le_bytes());
        scal.extend_from_slice(&self.r10698208.to_le_bytes());
        scal.extend_from_slice(&self.r10697ce6.to_le_bytes());
        scal.push(self.r10698141);
        scal.push(self.r10697ca8);
        scal.extend_from_slice(&self.tempo.to_le_bytes());
        scal.extend_from_slice(&self.speed.to_le_bytes());
        scal.push(self.order_position);
        scal.push(self.r10698140);
        scal.push(self.r10698200);
        scal.push(self.first_music_voice);
        section(b"SCAL", &scal);
        section(b"NAME", &self.song_name);
        section(b"ORDR", &self.orders);
        section(b"PANS", &self.initial_pan);
        section(b"SCRT", &self.scratch);
        section(b"VOIC", &self.voices);
        for (slot, ins) in self.instruments.iter().enumerate() {
            let Some(ins) = ins else { continue };
            let mut payload = (slot as u16).to_le_bytes().to_vec();
            payload.extend_from_slice(&(ins.bytes.len() as u32).to_le_bytes());
            payload.extend_from_slice(&ins.bytes);
            section(b"INST", &payload);
            let samples = get16(&ins.bytes, 0x148) as usize;
            for (k, data) in ins.data.iter().enumerate().take(samples) {
                let Some(data) = data else { continue };
                let mut payload = (slot as u16).to_le_bytes().to_vec();
                payload.extend_from_slice(&(k as u16).to_le_bytes());
                payload.extend_from_slice(&(data.len() as u32).to_le_bytes());
                payload.extend_from_slice(data);
                section(b"SDAT", &payload);
            }
        }
        for (p, pattern) in self.patterns.iter().enumerate() {
            let Some(pattern) = pattern else { continue };
            let mut payload = (p as u16).to_le_bytes().to_vec();
            payload.extend_from_slice(&pattern.header);
            payload.extend_from_slice(&(pattern.events.len() as u32).to_le_bytes());
            payload.extend_from_slice(&pattern.events);
            section(b"PATT", &payload);
        }
        let mut alog = Vec::new();
        for &(op, size) in &self.alloc_log {
            alog.push(op);
            alog.extend_from_slice(&size.to_le_bytes());
        }
        section(b"ALOG", &alog);
        let mut slog = Vec::new();
        for &(op, a, b, pos) in &self.stream_log {
            slog.push(op);
            for v in [a, b, pos] {
                slog.extend_from_slice(&v.to_le_bytes());
            }
        }
        section(b"SLOG", &slog);
        out
    }
}

/// IMPS -> glxSample fields shared by both modes (sample mode
/// 0x10629764..0x1062990b, instrument mode 0x10629374..0x10629588).
fn convert_sample(ins: &mut [u8], at: usize, smp: &[u8], mutant: u32) {
    put32(ins, at + 0x30, get32(smp, 0x30));
    put32(ins, at + 0x34, get32(smp, 0x34));
    put32(ins, at + 0x38, get32(smp, 0x38));
    // Word store, then the re-read word is clamped: Vol 128 stores 0.
    let vol = ((smp[0x13] as u32) << 9) as u16;
    let vol = if mutant == MUTANT_VOLUME_CLAMP_DWORD {
        if (smp[0x13] as u32) << 9 > 0x7fff { 0x7fff } else { vol }
    } else if vol > 0x7fff {
        0x7fff
    } else {
        vol
    };
    put16(ins, at + 0x2a, vol);
    let flg = smp[0x12] as u16;
    let mut kind = 0x80 | ((flg & 2) << 1) | ((flg & 0x10) >> 1);
    kind |= ((flg & 0x40) >> 2) | ((smp[0x2f] as u16 & 0x80) >> 2);
    kind |= ((smp[0x2e] as u16 & 1) ^ 1) << 1;
    put16(ins, at + 0x2c, kind);
    let pan = (((smp[0x2f] & 0x7f) as u32) << 9) as u16;
    put16(ins, at + 0x28, if pan > 0x7fff { 0x7fff } else { pan });
    put16(ins, at + 0x2e, 0);
    put32(ins, at + 0x3c, get32(smp, 0x3c));
}

// ---- Wasm exports -----------------------------------------------------------

thread_local! {
    static LIBRARY: RefCell<Library> = RefCell::new(Library::new(16));
    static INPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static DUMP: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static MUTANT: RefCell<u32> = const { RefCell::new(0) };
}

/// A fresh library: glxInit's state, then EffectsChannels voices for effects.
#[no_mangle]
pub extern "C" fn galaxy_reset(effects_channels: u32) {
    let mutant = MUTANT.with(|m| *m.borrow());
    LIBRARY.with(|l| {
        let mut library = Library::new(effects_channels as u8);
        library.mutant = mutant;
        *l.borrow_mut() = library;
    });
}

/// Room for a module of `len` bytes plus the caller's 1024-byte slack (zeroed).
#[no_mangle]
pub extern "C" fn galaxy_input(len: u32) -> *mut u8 {
    INPUT.with(|i| {
        let mut input = i.borrow_mut();
        input.clear();
        input.resize(len as usize + SLACK as usize, 0);
        input.as_mut_ptr()
    })
}

/// glxLoadMusic on the module in the input buffer (`len` bytes).
#[no_mangle]
pub extern "C" fn galaxy_load(len: u32) -> u32 {
    INPUT.with(|i| {
        let input = i.borrow();
        LIBRARY.with(|l| {
            let mut library = l.borrow_mut();
            let status = library.load_music(&input, len);
            DUMP.with(|d| *d.borrow_mut() = library.dump(status));
            status
        })
    })
}

#[no_mangle]
pub extern "C" fn galaxy_unload() -> u32 {
    LIBRARY.with(|l| l.borrow_mut().unload_music())
}

/// Clear the allocation and stream logs (the dump reports what follows).
#[no_mangle]
pub extern "C" fn galaxy_clear_logs() {
    LIBRARY.with(|l| {
        let mut library = l.borrow_mut();
        library.alloc_log.clear();
        library.stream_log.clear();
    });
}

#[no_mangle]
pub extern "C" fn galaxy_hazards() -> u32 {
    LIBRARY.with(|l| l.borrow().hazards)
}

/// Rebuild the dump from the current state (after galaxy_load it is ready).
#[no_mangle]
pub extern "C" fn galaxy_dump(status: u32) -> *const u8 {
    LIBRARY.with(|l| DUMP.with(|d| {
        let mut dump = d.borrow_mut();
        *dump = l.borrow().dump(status);
        dump.as_ptr()
    }))
}

#[no_mangle]
pub extern "C" fn galaxy_dump_ptr() -> *const u8 {
    DUMP.with(|d| d.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn galaxy_dump_len() -> u32 {
    DUMP.with(|d| d.borrow().len() as u32)
}

#[no_mangle]
pub extern "C" fn galaxy_set_mutant(id: u32) {
    MUTANT.with(|m| *m.borrow_mut() = id);
    LIBRARY.with(|l| l.borrow_mut().mutant = id);
}
