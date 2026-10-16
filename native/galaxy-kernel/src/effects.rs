//! Galaxy's sample (effect voice) entries, translated from Galaxy.dll (GOTY,
//! preferred base 0x10600000). docs/galaxy-music/effects.md is the
//! address-anchored contract; every function names the original it
//! translates. The structures are GALAXY.H's (`glxSample`, `glxVoice`):
//!
//! - glxLoadSample 0x10618e60 with GLX_LOADFROMMEMORY (the only flags
//!   RegisterSound 0x10606af0 passes, 0x10606b91) and its RIFF WAVE loader
//!   0x10619940 for PCM (format tag 1), the only coding of the 549 shipped
//!   WAV sounds (mono, 16-bit, 11025..44100 Hz);
//! - glxStartSample 0x10612310 for a fixed voice (Voice != 0: the subsystem
//!   always passes its channel + 1, 0x1060a42e..0x1060a435);
//! - glxControlSample 0x1060d280, glxControlVoice 0x1060cf00 and
//!   glxStopSample 0x10618410.
//!
//! The mixer (sequencer.rs `mix`, mixer.rs) already mixes every effect slot
//! [0, EffectsChannels) onto bus B; these entries write the voice records it
//! reads.
//!
//! The ring path of glxStartSample and glxStopSample (types 0xe000 and 0x40:
//! compressed, streamed and stereo samples, a 64 KB ring the decoder thread
//! 0x1060e340 feeds) is translated with the decoder thread in ring.rs.
//!
//! Not translated (a fault code instead of a guess): the other loaders of
//! glxLoadSample's dispatch ('AS  ' 0x1062b640, '.snd' 0x1062b4c0, 'SCRS'
//! 0x1062b410, the MPEG path 0x10620b30, whose record `host_sample` stands
//! in for), IMA ADPCM and MPEG WAVs, and streaming loads (flags 8). Output
//! type [0x1069817a] is 0 (Use3dHardware False), so the 3D voice poll
//! 0x106126f0 and the 3D branches of the stop and the status query do
//! nothing.
//!
//! Address model: the records and their data get the addresses of a bump
//! heap at EFFECT_HEAP (16-byte rounding, at least 16, nothing reused), the
//! oracle's (scripts/native-galaxy-effects-oracle.py) allocator for these
//! loads; the music loader keeps its own (HEAP_BASE). Voice handles are the
//! voices' addresses at the preferred base, 0x1068dca0 + 0xa0·slot. Mutex
//! handles (CreateMutexA, voice +0x98) are the oracle's: MUTEX_BASE + 4·n
//! for the n-th call since the library was opened. No code path reads an
//! absolute address's value.
//!
//! Host-decoded speech (`host_sample`, `host_sample_attach`,
//! `host_sample_release`; docs/galaxy-audio.md "Speech on Galaxy's ring
//! transport"): the record stands in for the MPEG loader 0x10620b30's. That
//! loader writes SAMP, +0x04 0x40, +0x28 0x4000, +0x2a 0x7fff, +0x2c 0x4024
//! (mono) or 0x4044 (any other MPEG mode: stereo), +0x30 the MP3's byte
//! length, +0x34 = +0x38 = 0, +0x3c the rate of its table 0x10640f40, +0x44
//! the MP3 bytes (0x10620cd5..0x10620d99). The stand-in writes the same
//! fields except that the source is the browser's decode of the MP3 (row
//! 4.5.6, the user's decision of 2026-10-16): +0x30 is the PCM's byte length
//! and +0x44 the PCM (16-bit, interleaved for stereo), which ring.rs's
//! decoder leaf reads in place of the MPEG decoder 0x1061a690. So speech
//! plays through glxStartSample's ring branch, the refill posts and the
//! decoder thread's ring logic, as in the original. The record takes a
//! bump-heap address as a WAVE record does (the simulation's registry and the
//! worklet allocate in the same order); the PCM lives in a separate pool
//! (HOST_POOL), attached when the host decode arrives and released when no
//! voice plays it.
use super::*;
use crate::sequencer::{Region, UNSUPPORTED_DIVIDE, UNSUPPORTED_READ};

pub(crate) const EFFECT_HEAP: u32 = 0x6000_0000;
pub(crate) const VOICE_BASE: u32 = 0x1068dca0;
pub(crate) const MUTEX_BASE: u32 = 0x1000;
/// The host-decoded PCM pool (not an original allocation; see the file comment).
pub(crate) const HOST_POOL: u32 = 0x8000_0000;
pub(crate) const HOST_POOL_END: u32 = 0xf000_0000;
const AMIGA_PERIOD_INDEX: u32 = (0x1063de90 - 0x1063daa0) / 4; // the dword the start reads in player mode 1

const RIFF_FMT: &[u8; 4] = b"fmt ";
const RIFF_DATA: &[u8; 4] = b"data";
const RIFF_SMPL: &[u8; 4] = b"smpl";

// Faults of the sample entries (the original would run an untranslated path).
pub const UNSUPPORTED_SAMPLE_LOADER: u32 = 0x130; // 'AS  ', '.snd', 'SCRS' or the MPEG dispatch of glxLoadSample
pub const UNSUPPORTED_SAMPLE_CODING: u32 = 0x131; // a WAV data chunk of format 0x11 (IMA ADPCM) or 0x55 (MPEG)
pub const UNSUPPORTED_STREAMING: u32 = 0x132; // flags 8 (GLX_LOADASSTREAMING)
pub const UNSUPPORTED_RING_VOICE: u32 = 0x133; // (retired: the ring path is translated, ring.rs)
pub const UNSUPPORTED_AUTO_VOICE: u32 = 0x134; // glxStartSample(Voice = 0): the free-voice search
pub const UNSUPPORTED_VOICE: u32 = 0x135; // a voice pointer outside the voice table
pub const UNSUPPORTED_SHORT_PEEK: u32 = 0x136; // fewer than 0x50 bytes: the dispatch reads uninitialised stack
pub const HOST_SAMPLE_MISSING: u32 = 0x137; // attach/release of an address that is no host-decoded record
pub const HOST_POOL_FULL: u32 = 0x138; // the host PCM pool would pass HOST_POOL_END

// Test-only translation mutants (validate-galaxy-effects.mjs).
pub const MUTANT_LOOP_END_PLUS_ONE: u32 = 301; // the smpl loop end taken as exclusive (+1)
pub const MUTANT_CONTROL_KEEPS_STEP: u32 = 302; // glxControlSample without the step recompute
pub const MUTANT_DEFAULT_PAN_CENTRE: u32 = 303; // Panning -1 ignores GLX_PANNING (keeps the voice's pan)
pub const MUTANT_NO_PAD_ZERO: u32 = 304; // the 31 bytes after the data hold the next sound's bytes, not zeros

/// One glxLoadSample result: the 0x48-byte glxSample at `addr` and its Data
/// allocation (`data_addr`, the data chunk plus 31 zero bytes).
pub(crate) struct EffectSample {
    pub addr: u32,
    pub record: [u8; 0x48],
    pub data_addr: u32,
    pub data: Vec<u8>,
    /// A host-decoded speech record (`host_sample`), whose data is attached
    /// and released by the host.
    pub host: bool,
}

/// The effect side's library state.
pub(crate) struct Effects {
    pub samples: Vec<EffectSample>,
    pub heap_top: u32,
    pub mutexes: u32,
    /// Data of a sample whose record was kept but whose bytes the host
    /// dropped (galaxy_sample_forget): reads of it fault.
    pub forgotten: Vec<u32>,
    /// Ring voices' 64 KB rings by voice slot (ring.rs address model).
    pub rings: Vec<Option<Vec<u8>>>,
    /// Refill messages posted to the decoder thread (wParam, lParam), not yet handled.
    pub posts: std::collections::VecDeque<(u32, u32)>,
}

impl Effects {
    pub(crate) fn new() -> Self {
        Effects { samples: Vec::new(), heap_top: EFFECT_HEAP, mutexes: 0, forgotten: Vec::new(), rings: (0..VOICES).map(|_| None).collect(),
            posts: std::collections::VecDeque::new() }
    }
    fn malloc(&mut self, size: u32) -> u32 {
        let ptr = self.heap_top;
        self.heap_top = self.heap_top.wrapping_add((size.wrapping_add(15) & !15).max(16));
        ptr
    }
    pub(crate) fn sample(&self, addr: u32) -> Option<&EffectSample> {
        self.samples.iter().find(|s| s.addr == addr)
    }
}

impl Library {
    // ---- glxLoadSample ----------------------------------------------------------

    /// glxLoadSample 0x10618e60(&glxMemory{'MEMO', 0xc, input, len, 0}, 2):
    /// returns the glxSample's address, 0 when the loader gives none (the
    /// record allocation then leaks, as in the original), or a fault.
    pub fn glx_load_sample(&mut self, input: &[u8], flags: u32) -> Result<u32, u32> {
        // A load that faults (an untranslated path) leaves the sample heap as it
        // was, so that the host's two library instances (the simulation's
        // registry and the worklet's) keep allocating the same addresses.
        let top = self.effects.heap_top;
        let result = self.glx_load_sample_inner(input, flags);
        if result.is_err() {
            self.effects.heap_top = top;
        }
        result
    }

    fn glx_load_sample_inner(&mut self, input: &[u8], flags: u32) -> Result<u32, u32> {
        if flags & 8 != 0 {
            return Err(UNSUPPORTED_STREAMING);
        }
        let len = input.len() as u32;
        let mut s = Stream { data: input, length: len, module: len, pos: 0, log: Vec::new(), hazards: 0 };
        // 0x10618ed0: malloc(0x48) through [0x1064a738], zeroed.
        let addr = self.effects.malloc(0x48);
        let mut record = [0u8; 0x48];
        // 0x10618ef1..0x10618f06: peek 0x50 bytes, seek back.
        let mut peek = [0u8; 0x50];
        let got = s.read(&mut peek, 1, 0x50)?;
        if got < 0x50 {
            return Err(UNSUPPORTED_SHORT_PEEK);
        }
        s.seek(0u32.wrapping_sub(0x50), 1);
        let result = if &peek[8..12] == b"AS  " || &peek[0..4] == b".snd" {
            return Err(UNSUPPORTED_SAMPLE_LOADER);
        } else if &peek[8..12] == b"WAVE" {
            self.load_wave(addr, &mut record, &mut s, flags)?
        } else {
            return Err(UNSUPPORTED_SAMPLE_LOADER); // 'SCRS' at +0x4c, else the MPEG path 0x10620b30
        };
        self.hazards |= s.hazards;
        Ok(result)
    }

    /// The RIFF WAVE loader 0x10619940(Sample, Stream, Flags).
    fn load_wave(&mut self, addr: u32, record: &mut [u8; 0x48], s: &mut Stream, _flags: u32) -> Result<u32, u32> {
        let mut result = 0u32;
        let mut riff = [0u8; 12];
        s.read(&mut riff, 1, 0xc)?;
        // 0x10619964..0x1061996f: ((size + 1) & ~1) - 4 bytes of chunks.
        let mut remaining = get32(&riff, 4).wrapping_add(1) & !1;
        remaining = remaining.wrapping_sub(4);
        // The fmt locals (F+0x30..0x40) and the smpl locals keep their
        // values across chunks, as the stack frame does; never read before
        // a fmt chunk in the shipped files (a data chunk first would read
        // uninitialised stack in the original: refused below).
        let mut fmt: Option<[u8; 0x10]> = None;
        let mut data: Option<(u32, Vec<u8>)> = None;
        while remaining != 0 {
            let mut header = [0u8; 8];
            if s.read(&mut header, 1, 8)? == 0 {
                // 0x10619996: a read of nothing jumps back to the `remaining != 0`
                // test (0x10619cbb) with nothing changed: past the stream's end
                // with chunk bytes still owed, the original never returns.
                return Err(crate::sequencer::UNSUPPORTED_SPIN);
            }
            let id = &header[0..4];
            let size = get32(&header, 4);
            if id == RIFF_FMT {
                let mut f = [0u8; 0x10];
                s.read(&mut f, 1, 0x10)?;
                if get16(&f, 0) == 1 {
                    s.seek(size.wrapping_sub(0x10), 1);
                } else {
                    let mut extra = [0u8; 4];
                    s.read(&mut extra, 1, 4)?;
                    s.seek(size.wrapping_sub(0x14), 1);
                }
                fmt = Some(f);
            } else if id == RIFF_DATA {
                let f = fmt.ok_or(UNSUPPORTED_READ)?;
                let tag = get16(&f, 0);
                if tag == 1 {
                    let channels = get16(&f, 2);
                    let rate = get32(&f, 4);
                    let align = get16(&f, 0xc) as u32;
                    let bits = get16(&f, 0xe);
                    // 0x10619a26..0x10619a6c: mono 0x20 (GLX_PANNING), stereo 0x40, 16-bit 4.
                    let kind = if channels != 2 { 0x20u16 } else { 0x40 } | if bits == 16 { 4 } else { 0 };
                    if align == 0 {
                        return Err(UNSUPPORTED_DIVIDE); // div ebx at 0x10619a70
                    }
                    put32(record, 0, SAMP);
                    put32(record, 4, 0x40);
                    put16(record, 0x28, 0x4000);
                    put32(record, 0x30, size / align);
                    put16(record, 0x2a, 0x7fff);
                    put16(record, 0x2c, kind);
                    put32(record, 0x34, 0);
                    put32(record, 0x38, 0);
                    put32(record, 0x3c, rate);
                    // 0x10619a9d: malloc(size + 0x1f) (never fails here).
                    let total = size.wrapping_add(0x1f);
                    let data_addr = self.effects.malloc(total);
                    put32(record, 0x44, data_addr);
                    let mut bytes = vec![0u8; total as usize];
                    let length = get32(record, 0x30);
                    let wanted = (align as u64) * (length as u64);
                    if wanted > total as u64 {
                        return Err(UNSUPPORTED_READ);
                    }
                    s.read(&mut bytes, align, length)?;
                    // 0x10619acc..0x10619ae3: 31 zero bytes at Data + size (already zero).
                    if self.mutant(MUTANT_NO_PAD_ZERO) {
                        for b in bytes.iter_mut().skip(size as usize) {
                            *b = 0x55;
                        }
                    }
                    if bits == 8 {
                        // 0x10619aec..0x10619b07: + 0x80 over Length bytes.
                        for b in bytes.iter_mut().take(length as usize) {
                            *b = b.wrapping_add(0x80);
                        }
                    }
                    data = Some((data_addr, bytes));
                    result = addr;
                } else if tag == 0x11 || tag == 0x55 {
                    return Err(UNSUPPORTED_SAMPLE_CODING);
                }
                // Other tags: the tail below, the body not skipped (0x10619c1e).
            } else if id == RIFF_SMPL {
                let mut smpl = [0u8; 0x3c];
                s.read(&mut smpl, 1, 0x3c)?;
                s.seek(size.wrapping_sub(0x3c), 1);
                if get32(&smpl, 0x1c) != 0 {
                    // 0x10619c5d..0x10619c79: GLX_LOOPED | (type & 1 ? GLX_BIDILOOP : 0).
                    let kind = get16(record, 0x2c) | 8 | (((smpl[0x28] & 1) as u16) << 4);
                    put32(record, 0x34, get32(&smpl, 0x2c));
                    put16(record, 0x2c, kind);
                    let end = get32(&smpl, 0x30);
                    put32(record, 0x38, if self.mutant(MUTANT_LOOP_END_PLUS_ONE) { end.wrapping_add(1) } else { end });
                }
            } else {
                s.seek(size, 1);
            }
            // 0x10619c8f..0x10619cb7: the pad byte, then 8 + even size.
            s.seek(size & 1, 1);
            remaining = remaining.wrapping_add(0xffff_fff8u32.wrapping_sub(size.wrapping_add(1) & !1));
        }
        let (data_addr, bytes) = data.unwrap_or((0, Vec::new()));
        self.effects.samples.push(EffectSample { addr, record: *record, data_addr, data: bytes, host: false });
        self.rebuild_regions();
        Ok(result)
    }

    // ---- host-decoded speech (a stand-in; see the file comment) -------------------

    /// The record for a speech MP3 the host decodes (the stand-in of the
    /// MPEG loader's, see the file comment): type 0x4024 for a mono stream,
    /// 0x4044 for `channels` 2, the rate, and `frames` frames of 16-bit PCM
    /// as the source length until the PCM is attached; no data. The record
    /// takes the bump heap's next 0x48 bytes, as glxLoadSample's malloc
    /// (0x10618ed0).
    pub fn host_sample(&mut self, rate: u32, frames: u32, channels: u32) -> u32 {
        let addr = self.effects.malloc(0x48);
        let mut record = [0u8; 0x48];
        let stereo = channels == 2;
        put32(&mut record, 0, SAMP);
        put32(&mut record, 4, 0x40);
        put16(&mut record, 0x28, 0x4000);
        put32(&mut record, 0x30, frames.wrapping_mul(if stereo { 4 } else { 2 }));
        put16(&mut record, 0x2a, 0x7fff);
        put16(&mut record, 0x2c, if stereo { 0x4044 } else { 0x4024 });
        put32(&mut record, 0x3c, rate);
        self.effects.samples.push(EffectSample { addr, record, data_addr: 0, data: Vec::new(), host: true });
        addr
    }

    fn host_index(&self, addr: u32) -> Result<usize, u32> {
        self.effects.samples.iter().position(|s| s.addr == addr && s.host).ok_or(HOST_SAMPLE_MISSING)
    }

    /// The host's decoded 16-bit PCM (interleaved for a stereo record) for
    /// the record at `addr`: the source length (+0x30) becomes its byte
    /// length and the source (+0x44) its pool address; 31 zero bytes follow.
    /// The pool address is past every attached host sample's data (HOST_POOL
    /// when none is attached).
    pub fn host_sample_attach(&mut self, addr: u32, pcm: &[u8]) -> Result<u32, u32> {
        let index = self.host_index(addr)?;
        let frames = (pcm.len() / 2) as u32;
        let size = frames * 2 + 0x1f;
        let mut top = HOST_POOL;
        for s in &self.effects.samples {
            if s.host && s.data_addr != 0 && s.addr != addr {
                top = top.max(s.data_addr + ((s.data.len() as u32 + 15) & !15));
            }
        }
        if (top as u64) + (size as u64) > HOST_POOL_END as u64 {
            return Err(HOST_POOL_FULL);
        }
        let mut data = vec![0u8; size as usize];
        data[..frames as usize * 2].copy_from_slice(&pcm[..frames as usize * 2]);
        let sample = &mut self.effects.samples[index];
        put32(&mut sample.record, 0x30, frames * 2);
        put32(&mut sample.record, 0x44, top);
        sample.data_addr = top;
        sample.data = data;
        self.rebuild_regions();
        Ok(addr)
    }

    /// Drops the PCM of the record at `addr` (the record stays registered, as
    /// USound +0x50 keeps it): Data (+0x44) is 0 again.
    pub fn host_sample_release(&mut self, addr: u32) -> Result<u32, u32> {
        let index = self.host_index(addr)?;
        let sample = &mut self.effects.samples[index];
        put32(&mut sample.record, 0x44, 0);
        sample.data_addr = 0;
        sample.data = Vec::new();
        self.rebuild_regions();
        Ok(0)
    }

    // ---- voices -------------------------------------------------------------------

    pub(crate) fn voice_slot(&self, voice: u32) -> Result<usize, u32> {
        let off = voice.wrapping_sub(VOICE_BASE);
        if off % VOICE as u32 != 0 || off / VOICE as u32 >= VOICES as u32 {
            return Err(UNSUPPORTED_VOICE);
        }
        Ok((off / VOICE as u32) as usize)
    }

    pub(crate) fn sample_record(&self, addr: u32) -> Result<[u8; 0x48], u32> {
        self.effects.sample(addr).map(|s| s.record).ok_or(UNSUPPORTED_READ)
    }

    /// glxStartSample 0x10612310(Voice, Sample, Frequency, Volume, Panning, Flags).
    pub fn glx_start_sample(&mut self, voice: i32, sample: u32, frequency: i32, volume: i32, pan: i32, flags: u32) -> Result<u32, u32> {
        if self.first_music_voice == 0 || sample == 0 {
            return Ok(0);
        }
        let rec = self.sample_record(sample)?;
        if get32(&rec, 0) != SAMP {
            return Ok(0);
        }
        let kind = get16(&rec, 0x2c);
        let ring = kind & 0xe000 != 0 || kind & 0x40 != 0;
        if voice == 0 {
            return Err(UNSUPPORTED_AUTO_VOICE);
        }
        let count = if kind & 0x40 != 0 { 2 } else { 1 };
        let (mut prev, mut cur) = (0u32, 0u32);
        for i in 0..count {
            prev = cur;
            // 0x106123fd..0x10612405: 0x1068dc00 + (Voice + i)·0xa0.
            cur = 0x1068dc00u32.wrapping_add((voice as u32).wrapping_add(i).wrapping_mul(VOICE as u32));
            let v = self.voice_slot(cur)?;
            self.glx_stop_sample(cur)?; // returns 0 for a non-null voice
            let data = get32(&rec, 0x44);
            if data == 0 {
                continue; // 0x10612424: the next voice, no failure
            }
            // 0x1061243a..0x1061246f: a ring pair's second voice starts at -2 too.
            let start_time = if flags & 1 != 0 || (ring && i != 0) { 0xffff_fffe } else { self.player.tick_count };
            self.sd(v, 0x08, start_time);
            self.sb(v, 0x0c, 0x3c);
            self.sb(v, 0x0d, 0);
            self.sb(v, 0x0e, 0);
            self.sb(v, 0x0f, 1);
            self.sb(v, 0x10, 1);
            self.sb(v, 0x11, if i == 0 { flags as u8 | 8 } else { flags as u8 & 0xf5 });
            self.sw(v, 0x18, 0x7fff);
            self.sw(v, 0x1a, 0x7fff);
            self.sd(v, 0x20, 0);
            self.sw(v, 0x24, 0x7fff);
            self.sw(v, 0x28, 0);
            self.sw(v, 0x2a, 0x7fff);
            self.sb(v, 0x2c, 0);
            self.sw(v, 0x34, 0);
            self.sw(v, 0x30, 0);
            self.sw(v, 0x2e, 0);
            self.sb(v, 0x2d, 0);
            self.sw(v, 0x36, 0);
            self.sw(v, 0x3a, 0);
            self.sw(v, 0x3c, 0);
            self.sb(v, 0x3e, 0);
            self.sd(v, 0x42, sample);
            // 0x106124d7..0x10612502: a ring voice's data is a fresh 64 KB ring (ring.rs).
            let mut ptr = if ring { self.ring_alloc(v) } else { data };
            if kind & 4 != 0 {
                ptr >>= 1;
            }
            self.sd(v, 0x46, ptr);
            self.sw(v, 0x4a, 0);
            self.sw(v, 0x4c, kind);
            if !ring {
                self.sd(v, 0x4e, ptr);
                self.sd(v, 0x52, get32(&rec, 0x34).wrapping_add(ptr));
                self.sd(v, 0x56, get32(&rec, 0x38).wrapping_add(ptr));
                self.sd(v, 0x88, 0);
                self.sd(v, 0x5a, get32(&rec, 0x30).wrapping_add(ptr));
                self.sd(v, 0x8c, 0);
                self.sd(v, 0x90, 0);
                self.sd(v, 0x94, 0);
            } else {
                // 0x10612562..0x1061258f: looped, loop always, over [ring, ring + 0x7fff];
                // the write position's 0x10000 sentinel (the decoder thread's first fill).
                self.sb(v, 0x4c, self.vb(v, 0x4c) | 0x88);
                let end = ptr.wrapping_add(if self.mutant(crate::ring::MUTANT_RING_LOOP_8000) { 0x8000 } else { 0x7fff });
                self.sd(v, 0x56, end);
                self.sd(v, 0x5a, end);
                self.sd(v, 0x4e, ptr);
                self.sd(v, 0x52, ptr);
                self.sd(v, 0x88, 0x10000);
                self.sd(v, 0x8c, 0);
                self.sd(v, 0x90, 0x10000);
                self.sd(v, 0x94, 0x10000);
            }
            let c4 = if frequency == -1 { get32(&rec, 0x3c) } else { frequency as u32 };
            self.sd(v, 0x5e, c4);
            let vol = if volume == -1 { get16(&rec, 0x2a) } else { volume as u16 };
            self.sw(v, 0x66, vol);
            self.sw(v, 0x68, vol);
            // 0x106125be..0x106125ea.
            let p = if pan != -1 {
                Some(pan as u16)
            } else if count > 1 {
                Some(if i & 1 != 0 { 0x7fff } else { 0 })
            } else if kind & 0x20 != 0 && !self.mutant(MUTANT_DEFAULT_PAN_CENTRE) {
                Some(get16(&rec, 0x28))
            } else {
                None
            };
            if let Some(p) = p {
                self.sw(v, 0x16, p);
                self.sw(v, 0x14, p);
            }
            self.set_step(v, c4)?;
            // 0x1061261f..0x10612656: the period (no effect voice update reads it).
            let period = if self.player_mode & 1 != 0 {
                if c4 == 0 { 0 } else { (self.table(AMIGA_PERIOD_INDEX)? as u32).wrapping_mul(0x20ab) / c4 }
            } else {
                0x3c00
            };
            self.sw(v, 0x6a, period as u16);
            self.sw(v, 0x6c, period as u16);
            self.sw(v, 0x72, 0);
            self.sw(v, 0x76, 0);
            // CreateMutexA(0, 1, 0), released before the return (ReleaseMutex at 0x106126b3).
            let mutex = MUTEX_BASE.wrapping_add(4u32.wrapping_mul(self.effects.mutexes));
            self.effects.mutexes = self.effects.mutexes.wrapping_add(1);
            self.sd(v, 0x98, mutex);
            self.sd(v, 0x9c, 0);
            if prev != 0 {
                let pv = self.voice_slot(prev)?;
                self.sd(pv, 0x9c, cur);
            }
        }
        Ok(if prev != 0 { prev } else { cur })
    }

    /// The step from C4Speed (0x106125ee..0x1061261c, 0x1060d30e..0x1060d33c).
    fn set_step(&mut self, v: usize, c4: u32) -> Result<(), u32> {
        let rate = self.player.rate;
        if rate == 0 {
            return Err(UNSUPPORTED_DIVIDE);
        }
        let step = ((c4 / rate) << 16).wrapping_add(((c4 % rate) << 16) / rate);
        self.sd(v, 0x62, step);
        Ok(())
    }

    /// glxControlSample 0x1060d280(Voice, Frequency, Volume, Panning), over
    /// the voice and its Link chain.
    pub fn glx_control_sample(&mut self, voice: u32, frequency: i32, volume: i32, pan: i32) -> Result<u32, u32> {
        if voice == 0 {
            return Ok(0x11);
        }
        let mut cur = voice;
        let mut guard = 0;
        while cur != 0 {
            let v = self.voice_slot(cur)?;
            let header = self.vd(v, 0x42);
            let c4 = if frequency == -1 { get32(&self.sample_record(header)?, 0x3c) } else { frequency as u32 };
            self.sd(v, 0x5e, c4);
            let vol = if volume == -1 { get16(&self.sample_record(header)?, 0x2a) } else { volume as u16 };
            self.sw(v, 0x66, vol);
            self.sw(v, 0x68, vol);
            let p = if pan != -1 {
                pan as u16
            } else if self.vb(v, 0x4c) & 0x20 != 0 {
                get16(&self.sample_record(header)?, 0x28)
            } else {
                self.vw(v, 0x14)
            };
            self.sw(v, 0x16, p);
            self.sw(v, 0x14, p);
            if !self.mutant(MUTANT_CONTROL_KEEPS_STEP) {
                self.set_step(v, c4)?;
            }
            cur = self.vd(v, 0x9c);
            guard += 1;
            if guard > VOICES {
                return Err(crate::sequencer::UNSUPPORTED_SPIN);
            }
        }
        Ok(0)
    }

    /// glxControlVoice 0x1060cf00(Voice, Command, Parameter1, Parameter2):
    /// GLX_SETMODE (Enabled), GLX_SETVOLUME (the Vol byte and its slide),
    /// GLX_GETSTATUS (Active; the 3D branch needs an output type of 2..5).
    pub fn glx_control_voice(&mut self, voice: u32, command: i32, p1: i32, p2: i32) -> Result<u32, u32> {
        if voice == 0 {
            return Ok(0x11);
        }
        let v = self.voice_slot(voice)?;
        match command {
            0 => {
                if p1 != 0 && p1 != 1 {
                    return Ok(0x11);
                }
                self.sb(v, 0x10, p1 as u8);
                Ok(0)
            }
            1 => {
                if !(0..=0x7f).contains(&p1) {
                    return Ok(0x11);
                }
                if p2 == 0 {
                    self.sb(v, 0x3f, p1 as u8);
                    self.sb(v, 0x40, 0);
                } else {
                    let step = if self.vb(v, 0x3f) as i32 >= p1 { (p2 as u8).wrapping_neg() } else { p2 as u8 };
                    self.sb(v, 0x40, step);
                }
                self.sb(v, 0x41, p1 as u8);
                Ok(0)
            }
            2 => Ok(self.vb(v, 0x0f) as u32),
            _ => Ok(0x11),
        }
    }

    /// glxStopSample 0x10618410(Voice). WaitForMultipleObjects over the
    /// chain's mutexes: with none (a voice never started, or stopped) it
    /// fails (n = 0 is invalid) and nothing changes; otherwise the game
    /// thread takes them at once (only the decoder thread, for ring voices,
    /// ever holds a voice mutex).
    pub fn glx_stop_sample(&mut self, voice: u32) -> Result<u32, u32> {
        if voice == 0 {
            return Ok(0x11);
        }
        let mut n = 0;
        let mut cur = voice;
        loop {
            let v = self.voice_slot(cur)?;
            if self.vd(v, 0x98) == 0 {
                break;
            }
            n += 1;
            cur = self.vd(v, 0x9c);
            if cur == 0 || n > VOICES {
                break;
            }
        }
        if n == 0 {
            return Ok(0);
        }
        let mut cur = voice;
        while cur != 0 {
            let v = self.voice_slot(cur)?;
            if self.vd(v, 0x98) == 0 {
                break;
            }
            let kind = self.vw(v, 0x4c);
            if kind & 0xe000 != 0 || kind & 0x40 != 0 {
                // 0x10618503..0x10618530: free the ring, clear the stream fields.
                let ring = self.vd(v, 0x4e);
                if ring != 0 {
                    self.ring_free(if kind & 4 != 0 { ring.wrapping_add(ring) } else { ring })?;
                }
                self.sd(v, 0x4e, 0);
                self.sd(v, 0x88, 0);
                self.sd(v, 0x8c, 0);
                self.sd(v, 0x90, 0);
                self.sd(v, 0x94, 0);
            }
            self.sd(v, 0x08, 0);
            self.sb(v, 0x0f, 0);
            self.sb(v, 0x11, 8);
            let next = self.vd(v, 0x9c);
            self.sd(v, 0x98, 0);
            self.sd(v, 0x9c, 0);
            cur = next;
        }
        Ok(0)
    }

    /// Bit i = voice i's Active byte (+0x0f), for the effect voices [0, min(32, first)).
    pub fn effects_active(&self) -> u32 {
        let mut bits = 0u32;
        for v in 0..(self.first_music_voice as usize).min(32) {
            if self.vb(v, 0x0f) != 0 {
                bits |= 1 << v;
            }
        }
        bits
    }

    /// The host keeps a sample's record and address but drops its bytes (the
    /// simulation side, which only needs the record).
    pub fn forget_sample_data(&mut self, addr: u32) {
        if let Some(s) = self.effects.samples.iter_mut().find(|s| s.addr == addr) {
            s.data = Vec::new();
            self.effects.forgotten.push(s.data_addr);
        }
        self.rebuild_regions();
    }

    pub(crate) fn effect_regions(&self, r: &mut Vec<(u32, u32, Region)>) {
        for (i, s) in self.effects.samples.iter().enumerate() {
            if s.data_addr != 0 && !s.data.is_empty() {
                r.push((s.data_addr, s.data.len() as u32, Region::Effect(i as u16)));
            }
        }
        for (slot, ring) in self.effects.rings.iter().enumerate() {
            if ring.is_some() {
                r.push((crate::ring::RING_POOL + slot as u32 * crate::ring::RING_STRIDE, crate::ring::RING_ALLOC as u32, Region::Ring(slot as u16)));
            }
        }
    }
}

// ---- Wasm exports -------------------------------------------------------------

fn with_library<R>(f: impl FnOnce(&mut Library) -> R) -> R {
    LIBRARY.with(|l| f(&mut l.borrow_mut()))
}
fn code(r: Result<u32, u32>) -> u32 {
    match r {
        Ok(v) => v,
        Err(e) => {
            with_library(|l| l.player.fault = e);
            0
        }
    }
}

/// glxLoadSample(&Mem{input, len}, GLX_LOADFROMMEMORY) on galaxy_input's
/// buffer; the sample's address, or 0 (galaxy_fault then names a fault, or
/// is 0 when the loader returned no sample). The input is released.
#[no_mangle]
pub extern "C" fn galaxy_sample_load(len: u32) -> u32 {
    let result = INPUT.with(|i| {
        let mut input = i.borrow_mut();
        let n = (len as usize).min(input.len());
        let r = with_library(|l| l.glx_load_sample(&input[..n], 2));
        *input = Vec::new();
        r
    });
    match result {
        Ok(v) => v,
        Err(e) => {
            with_library(|l| l.player.fault = e);
            0
        }
    }
}

/// The 0x48-byte glxSample at `addr` (null if none).
#[no_mangle]
pub extern "C" fn galaxy_sample_record(addr: u32) -> *const u8 {
    with_library(|l| l.effects.sample(addr).map_or(std::ptr::null(), |s| s.record.as_ptr()))
}

/// The Data allocation of the sample at `addr` and its length.
#[no_mangle]
pub extern "C" fn galaxy_sample_data(addr: u32) -> *const u8 {
    with_library(|l| l.effects.sample(addr).map_or(std::ptr::null(), |s| s.data.as_ptr()))
}
#[no_mangle]
pub extern "C" fn galaxy_sample_data_len(addr: u32) -> u32 {
    with_library(|l| l.effects.sample(addr).map_or(0, |s| s.data.len() as u32))
}
#[no_mangle]
pub extern "C" fn galaxy_sample_forget(addr: u32) {
    with_library(|l| l.forget_sample_data(addr))
}

/// A host-decoded speech record (`Library::host_sample`): its address.
#[no_mangle]
pub extern "C" fn galaxy_sample_host(rate: u32, frames: u32, channels: u32) -> u32 {
    with_library(|l| l.host_sample(rate, frames, channels))
}

/// Attaches galaxy_input's `len` bytes (16-bit PCM) to the host record at
/// `addr`; the address, or 0 with galaxy_fault set. The input is released.
#[no_mangle]
pub extern "C" fn galaxy_sample_attach(addr: u32, len: u32) -> u32 {
    let r = INPUT.with(|i| {
        let mut input = i.borrow_mut();
        let n = (len as usize).min(input.len());
        let r = with_library(|l| l.host_sample_attach(addr, &input[..n]));
        *input = Vec::new();
        r
    });
    code(r)
}

/// Releases the PCM of the host record at `addr`.
#[no_mangle]
pub extern "C" fn galaxy_sample_release(addr: u32) -> u32 {
    let r = with_library(|l| l.host_sample_release(addr));
    code(r)
}

/// glxStartSample; the voice pointer (preferred base) or 0; a fault sets galaxy_fault.
#[no_mangle]
pub extern "C" fn galaxy_sample_start(voice: i32, sample: u32, frequency: i32, volume: i32, pan: i32, flags: u32) -> u32 {
    let r = with_library(|l| l.glx_start_sample(voice, sample, frequency, volume, pan, flags));
    code(r)
}

#[no_mangle]
pub extern "C" fn galaxy_sample_control(voice: u32, frequency: i32, volume: i32, pan: i32) -> u32 {
    let r = with_library(|l| l.glx_control_sample(voice, frequency, volume, pan));
    code(r)
}

#[no_mangle]
pub extern "C" fn galaxy_sample_stop(voice: u32) -> u32 {
    let r = with_library(|l| l.glx_stop_sample(voice));
    code(r)
}

#[no_mangle]
pub extern "C" fn galaxy_voice_control(voice: u32, command: i32, p1: i32, p2: i32) -> u32 {
    let r = with_library(|l| l.glx_control_voice(voice, command, p1, p2));
    code(r)
}

/// Clears the sticky fault (the simulation's sample registry, which only
/// loads samples and goes on after an untranslated loader).
#[no_mangle]
pub extern "C" fn galaxy_clear_fault() {
    with_library(|l| l.player.fault = 0);
}

#[no_mangle]
pub extern "C" fn galaxy_effects_active() -> u32 {
    with_library(|l| l.effects_active())
}
