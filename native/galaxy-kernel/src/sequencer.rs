//! Galaxy's module player, translated from Galaxy.dll (GOTY, preferred base
//! 0x10600000): the mixer entry 0x10614920 up to the inner mixing kernel
//! (its voice-update pass, sequencer tick and per-voice hand-off), the
//! sequencer tick 0x10615710, the IT track handler 0x10616eb0, the note-delay
//! trigger 0x10617d40, the ramps 0x10617f50, period to step 0x10615660, and
//! the library entries the subsystem's Update calls around them
//! (glxStopMusic 0x106183a0, glxStartMusic 0x106122a0, glxControlMusic
//! 0x1060d0e0, glxSetMusicVolume 0x1060eb60, glxSetSampleVolume 0x1060ec00),
//! plus glxInit's tail and the output open's tail as the initial state.
//!
//! Contract: docs/galaxy-music/sequencer.md. Verified per tick against the
//! original under Unicorn (scripts/native-galaxy-music-sequencer-oracle.py,
//! scripts/validate-galaxy-music-sequencer.mjs). The inner kernel
//! `call [0x10698354]` is phase 3: here each call is recorded with its 14
//! arguments ('K'). Integer only, except the pan table (x87.rs).
//!
//! Where the original would read outside its allocations, divide by zero or
//! never leave a loop, the kernel stops with an UNSUPPORTED_* fault instead.
use super::*;
use std::rc::Rc;

const VOICE_TABLE: u32 = 0x1068dca0; // voice 0 at the preferred base
const CHAN: usize = 0x2a6; // 'CHAN' records at 0x106887c0, 32 of them
pub const CALLBACK_FRAMES: i32 = 882; // 20 ms timer callback at 44.1 kHz (Latency 40 / 2)

// Faults (the original crashes, hangs or reads foreign memory there).
pub const UNSUPPORTED_READ: u32 = 0x106; // a read outside every live allocation
pub const UNSUPPORTED_HANDLER: u32 = 0x107; // MIDI (0x106168b0) / mode 4 (0x10615a60) track handlers
pub const UNSUPPORTED_SPIN: u32 = 0x108; // a loop the original never leaves
pub const UNSUPPORTED_DIVIDE: u32 = 0x109; // integer division by zero (#DE)
pub const UNSUPPORTED_PAN: u32 = 0x10a; // pan index outside the table
pub const UNSUPPORTED_TABLE_READ: u32 = 0x10b; // LFO index past the .rdata tables

// Test-only mutants (validate-galaxy-music-sequencer.mjs).
pub const MUTANT_TICK_BEFORE_VOICE_UPDATE: u32 = 101;
pub const MUTANT_NO_PATTERN_END_PASS: u32 = 102;
pub const MUTANT_NULL_PATTERN_WAITS: u32 = 103;
pub const MUTANT_KEY_OFF_KEEPS_VOICE: u32 = 104;
pub const MUTANT_PAN_SLEW_256: u32 = 105;
pub const MUTANT_LINEAR_LOW_BITS: u32 = 106;
pub const MUTANT_RUN_WITHOUT_PLUS_ONE: u32 = 107;
pub const MUTANT_ARPEGGIO_SWAP: u32 = 108;
pub const MUTANT_PAN_TABLE_PC53: u32 = 109;

// The .rdata tables 0x1063daa0..0x1063ec00 as one block of dwords.
const LFO: usize = 0; // 0x1063daa0: sine, ramp, square (64 each)
const AMIGA: usize = 192; // 0x1063dda0
const LINEAR: usize = 312; // 0x1063df80
const ARPEGGIO: usize = 1080; // 0x1063eb80
const FINETUNE: usize = 1096; // 0x1063ebc0
const TABLE_DWORDS: usize = 1112;

/// The tables by formula; equality with the DLL's bytes is checked by the
/// validator (the oracle dumps them). Exceptions are the original's: Amiga
/// entries 110 (382) and 117 (255), finetune entry 7 (34468).
fn make_tables() -> Vec<i32> {
    use std::f64::consts::PI;
    let mut t = Vec::with_capacity(TABLE_DWORDS);
    for k in 0..64 {
        t.push((255.0 * (2.0 * PI * k as f64 / 64.0).sin()) as i32);
    }
    for k in 0..64i32 {
        t.push((255.0 * (63 - 2 * k) as f64 / 63.0).round() as i32);
    }
    for k in 0..64 {
        t.push(if k < 32 { 255 } else { -255 });
    }
    for n in 0..120 {
        t.push(match n {
            0..=20 => 65280,
            110 => 382,
            117 => 255,
            _ => (6848.0 * 2f64.powf(-(n as f64 - 60.0) / 12.0)).round() as i32,
        });
    }
    for k in 0..768 {
        t.push((32768.0 * 2f64.powf(-(k as f64) / 768.0)).floor() as i32);
    }
    for n in 0..16 {
        t.push((32768.0 * 2f64.powf(-(n as f64) / 12.0)).round() as i32);
    }
    for f in [0, 1, 2, 3, 4, 5, 6, 7, -8, -7, -6, -5, -4, -3, -2, -1] {
        t.push(if f == 7 { 34468 } else { (32768.0 * 2f64.powf(f as f64 / 96.0)).round() as i32 });
    }
    t
}

thread_local! {
    static TABLES: Rc<Vec<i32>> = Rc::new(make_tables());
    static PAN_TABLES: RefCell<Vec<(u32, Rc<Vec<i16>>)>> = const { RefCell::new(Vec::new()) };
}

pub(crate) fn tables() -> Rc<Vec<i32>> {
    TABLES.with(|t| t.clone())
}

pub(crate) fn pan_table(pc: u32) -> Rc<Vec<i16>> {
    PAN_TABLES.with(|c| {
        let mut cache = c.borrow_mut();
        if let Some((_, t)) = cache.iter().find(|(p, _)| *p == pc) {
            return t.clone();
        }
        let t = Rc::new(x87::pan_table(pc));
        cache.push((pc, t.clone()));
        t
    })
}

#[derive(Clone, Copy)]
pub(crate) enum Region {
    Instrument(u16),
    Sample(u16, u16),
    PatternHeader(u16),
    Events(u16),
}

/// Comparison trace (format in scripts/native-galaxy-music-sequencer-oracle.py).
pub(crate) struct Trace {
    pub buf: Vec<u8>,
    pub groups: Vec<u32>,
}

impl Trace {
    fn record(&mut self, tag: u8, payload: &[u8]) {
        self.buf.push(tag);
        self.buf.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        self.buf.extend_from_slice(payload);
    }
}

/// Library globals the player adds to the loader's (named by address).
pub(crate) struct Player {
    pub last_row: u8,       // 0x106981cc
    pub pattern_delay: u8,  // 0x1068828c
    pub loop_row: u8,       // 0x1068dc81
    pub loop_counter: u8,   // 0x10697d1c
    pub music_target: u8,   // 0x106886a5 (BSS zero at glxInit)
    pub music_step: u8,     // 0x106886a4
    pub sfx_master: u8,     // 0x1069817c (0x7f at glxInit)
    pub sfx_target: u8,     // 0x10697ce4
    pub sfx_step: u8,       // 0x10697ca0
    pub tick_count: u32,    // 0x10697ce0
    pub voice_counter: i32, // 0x10698204, 16.16 countdown to the next voice update
    pub voice_period: u32,  // 0x10697d20
    pub tick_counter: i32,  // 0x1069834c, 16.16 countdown to the next sequencer tick
    pub tick_period: u32,   // 0x1069818c
    pub rate: u32,          // 0x10697d18
    pub frames_mixed: u32,  // 0x10698194
    pub ahead: u32,         // 0x10697cdc, ring bytes rendered ahead (host-pinned)
    pub kernel_mode: u8,    // 0x10697cfc
    pub output_format: u8,  // 0x10698179
    pub output_open: u8,    // 0x10698394
    pub cpu: [u8; 3],       // MMX 0x1068dc80, SSE 0x10698340, 3DNow 0x10698190
    pub chan: Vec<u8>,      // 0x106887c0, 32 x 0x2a6
    pub pan: Option<Rc<Vec<i16>>>, // [0x10698390]
    pub pc: u32,
    pub tables: Rc<Vec<i32>>,
    pub regions: Vec<(u32, u32, Region)>,
    pub trace: Option<Trace>,
    pub ahead_pin: u32,
    pub fault: u32,
    pub mixer: crate::mixer::Mixer, // the six buses and mixer state (mixer.rs)
}

impl Player {
    pub(crate) fn new() -> Self {
        Player {
            last_row: 0,
            pattern_delay: 0,
            loop_row: 0,
            loop_counter: 0,
            music_target: 0,
            music_step: 0,
            sfx_master: 0x7f,
            sfx_target: 0,
            sfx_step: 0,
            tick_count: 0,
            voice_counter: 0x160ccc,
            voice_period: 0x160ccc,
            tick_counter: 0xe5b000,
            tick_period: 0xe5b000,
            rate: 0x5622,
            frames_mixed: 0,
            ahead: 0,
            kernel_mode: 0,
            output_format: 0,
            output_open: 0,
            cpu: [0; 3],
            chan: vec![0; 32 * CHAN],
            pan: None,
            pc: 64,
            tables: tables(),
            regions: Vec::new(),
            trace: None,
            ahead_pin: 0,
            fault: 0,
            mixer: crate::mixer::Mixer::new(),
        }
    }
}

impl Library {
    // ---- memory -------------------------------------------------------------

    /// Live allocations the player reads through pointers, by model address.
    pub(crate) fn rebuild_regions(&mut self) {
        let mut r = Vec::new();
        for (slot, ins) in self.instruments.iter().enumerate() {
            let Some(ins) = ins else { continue };
            r.push((ins.addr, ins.bytes.len() as u32, Region::Instrument(slot as u16)));
            for (k, data) in ins.data.iter().enumerate() {
                let Some(data) = data else { continue };
                let field = 0x14a + 0x48 * k + 0x44;
                if field + 4 <= ins.bytes.len() {
                    r.push((get32(&ins.bytes, field), data.len() as u32, Region::Sample(slot as u16, k as u16)));
                }
            }
        }
        for (p, pattern) in self.patterns.iter().enumerate() {
            let Some(pattern) = pattern else { continue };
            r.push((pattern.addr, 0x28, Region::PatternHeader(p as u16)));
            r.push((pattern.events_addr, pattern.events.len() as u32, Region::Events(p as u16)));
        }
        r.sort_by_key(|e| e.0);
        self.player.regions = r;
    }

    fn locate(&self, a: u32, n: u32) -> Result<(Region, usize), u32> {
        let regions = &self.player.regions;
        let i = regions.partition_point(|r| r.0 <= a);
        if i == 0 {
            return Err(UNSUPPORTED_READ);
        }
        let (start, len, region) = regions[i - 1];
        let off = a - start;
        match off.checked_add(n) {
            Some(end) if end <= len => Ok((region, off as usize)),
            _ => Err(UNSUPPORTED_READ),
        }
    }

    fn region_bytes(&self, region: Region) -> &[u8] {
        match region {
            Region::Instrument(s) => &self.instruments[s as usize].as_ref().unwrap().bytes,
            Region::Sample(s, k) => self.instruments[s as usize].as_ref().unwrap().data[k as usize].as_ref().unwrap(),
            Region::PatternHeader(p) => &self.patterns[p as usize].as_ref().unwrap().header,
            Region::Events(p) => &self.patterns[p as usize].as_ref().unwrap().events,
        }
    }

    fn rd(&self, a: u32, n: u32) -> Result<&[u8], u32> {
        let (region, off) = self.locate(a, n)?;
        Ok(&self.region_bytes(region)[off..off + n as usize])
    }
    fn rd8(&self, a: u32) -> Result<u8, u32> {
        Ok(self.rd(a, 1)?[0])
    }
    fn rd16(&self, a: u32) -> Result<u16, u32> {
        let b = self.rd(a, 2)?;
        Ok(u16::from_le_bytes([b[0], b[1]]))
    }
    fn rd32(&self, a: u32) -> Result<u32, u32> {
        let b = self.rd(a, 4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
    /// Track fields live in the pattern header (pattern + 0xc + 0x1c * track).
    fn wr32(&mut self, a: u32, v: u32) -> Result<(), u32> {
        let (region, off) = self.locate(a, 4)?;
        match region {
            Region::PatternHeader(p) => {
                put32(&mut self.patterns[p as usize].as_mut().unwrap().header, off, v);
                Ok(())
            }
            _ => Err(UNSUPPORTED_READ),
        }
    }

    fn inst_ptr(&self, idx: u8) -> u32 {
        self.instruments[idx as usize].as_ref().map_or(0, |i| i.addr)
    }
    fn pattern_ptr(&self, idx: u8) -> u32 {
        self.patterns[idx as usize].as_ref().map_or(0, |p| p.addr)
    }
    fn table(&self, i: u32) -> Result<i32, u32> {
        self.player.tables.get(i as usize).copied().ok_or(UNSUPPORTED_TABLE_READ)
    }

    // Voice record fields (raw 0xa0-byte layout at 0x1068dca0).
    fn vb(&self, v: usize, o: usize) -> u8 {
        self.voices[v * VOICE + o]
    }
    fn vw(&self, v: usize, o: usize) -> u16 {
        get16(&self.voices, v * VOICE + o)
    }
    fn vd(&self, v: usize, o: usize) -> u32 {
        get32(&self.voices, v * VOICE + o)
    }
    fn sb(&mut self, v: usize, o: usize, x: u8) {
        self.voices[v * VOICE + o] = x;
    }
    fn sw(&mut self, v: usize, o: usize, x: u16) {
        put16(&mut self.voices, v * VOICE + o, x);
    }
    fn sd(&mut self, v: usize, o: usize, x: u32) {
        put32(&mut self.voices, v * VOICE + o, x);
    }

    // ---- initial state and library entries ------------------------------------

    /// glxInit's tail (0x1060e1b4..0x1060e2a1: pan table, output format 7),
    /// then the output open's tail (0x10613948..0x10613aca) for a PCM format
    /// of `channels` x `bits` at `rate` with the subsystem's open flags.
    /// `cpu` = MMX, SSE, 3DNow as Init leaves them; `pc` = x87 precision bits.
    pub fn setup_output(&mut self, pc: u32, cpu: [u8; 3], rate: u32, channels: u16, bits: u16, flags: u8) -> u32 {
        self.player.pc = pc;
        self.player.pan = Some(pan_table(if self.mutant(MUTANT_PAN_TABLE_PC53) { 53 } else { pc }));
        self.player.output_format = 7;
        self.player.cpu = cpu;
        // 0x10613948..0x1061396a: output format bits.
        let b = bits as u8;
        let fmt = (((b & 0xf8) << 4) | ((b >> 3) & 2)) | ((channels >> 1) as u8) | (flags & 4);
        self.player.ahead = 0;
        self.player.output_format = fmt;
        // 0x10614080((fmt & 0x85) | 2): the kernel setup's mode byte.
        let mode = (fmt & 0x85) | 2;
        let [mmx, sse, now3d] = cpu;
        self.player.kernel_mode = if mmx == 0 {
            mode | 2
        } else if sse != 0 && fmt & 1 != 0 {
            mode | 0x43
        } else if now3d != 0 {
            if fmt & 1 != 0 { mode | 0x43 } else { mode | 2 }
        } else if fmt & 1 != 0 {
            (mode & 0xfd) | 0x41
        } else {
            mode | 2
        };
        // 0x106139bf..0x10613ac4: rescale every voice's step, store the rate, tick periods.
        if (0x1f40..=0xbb80).contains(&rate) {
            for v in 0..VOICES {
                let step = self.vd(v, 0x62) as i32 as i64;
                let product = step.wrapping_mul(self.player.rate as i64);
                self.sd(v, 0x62, (product / rate as i64) as u32);
            }
            self.player.rate = rate;
            if let Err(e) = self.recompute_periods() {
                return e;
            }
        }
        self.player.output_open = 1;
        OK
    }

    /// glxSetMusicVolume 0x1060eb60.
    pub fn set_music_volume(&mut self, volume: i32, rate: i32) -> u32 {
        if !(0..=0x7f).contains(&volume) {
            return 0x11;
        }
        if rate == 0 {
            self.music_master = volume as u8;
            self.player.music_step = rate as u8;
        } else {
            let r = if (self.music_master as i8 as i32) < volume { rate } else { rate.wrapping_neg() };
            self.player.music_step = r as u8;
        }
        self.player.music_target = volume as u8;
        OK
    }

    /// glxSetSampleVolume 0x1060ec00.
    pub fn set_sample_volume(&mut self, volume: i32, rate: i32) -> u32 {
        if !(0..=0x7f).contains(&volume) {
            return 0x11;
        }
        if rate == 0 {
            self.player.sfx_master = volume as u8;
            self.player.sfx_step = rate as u8;
        } else {
            let r = if (self.player.sfx_master as i8 as i32) < volume { rate } else { rate.wrapping_neg() };
            self.player.sfx_step = r as u8;
        }
        self.player.sfx_target = volume as u8;
        OK
    }

    /// glxStopMusic 0x106183a0.
    pub fn stop_music(&mut self) -> u32 {
        if self.playing == 0 {
            return 4;
        }
        if self.channels == 0 {
            return 3;
        }
        let first = self.first_music_voice as usize;
        for ch in 0..self.channels as usize {
            self.sb(first + ch, 0x10, 0);
        }
        self.playing = 0;
        OK
    }

    /// glxStartMusic 0x106122a0.
    pub fn start_music(&mut self) -> u32 {
        if self.playing != 0 {
            return 2;
        }
        if self.channels == 0 {
            return 3;
        }
        let first = self.first_music_voice as usize;
        for v in first..first + self.channels as usize {
            self.sb(v, 0x10, 1);
        }
        self.playing = 1;
        OK
    }

    /// glxControlMusic 0x1060d0e0 (1 = jump with ring flush, 2 = set position, 3 = loop flag).
    pub fn control_music(&mut self, cmd: i32, arg: i32) -> u32 {
        match cmd {
            1 | 2 => {
                let mut n = arg;
                if n < 0 {
                    n = n.wrapping_add(self.order_position as i32 + 2);
                }
                if n > self.song_length as i32 {
                    return 0x11;
                }
                self.order_position = n.wrapping_sub(1) as u8;
                if cmd == 1 {
                    self.break_flag = 1;
                    self.player.ahead = 0;
                }
                OK
            }
            3 => {
                self.loop_flag = arg as u8;
                OK
            }
            _ => 0x11,
        }
    }

    /// Update's start of a section (0x1060a822..0x1060a88d): glxStopMusic,
    /// clear +0x0f of 32 voices from the subsystem's first music voice,
    /// glxStartMusic, glxControlMusic(2, section), break flag set.
    pub fn update_start(&mut self, effects_channels: usize, section: u8) -> [u32; 3] {
        let a = self.stop_music();
        for i in 0..32 {
            let v = effects_channels + i;
            if v < VOICES {
                self.sb(v, 0xf, 0);
            }
        }
        let b = self.start_music();
        let c = self.control_music(2, section as i32);
        self.break_flag = 1;
        [a, b, c]
    }

    /// Tick periods for the current mode/tempo/speed (0x10613a10..0x10613ac4,
    /// 0x106158c7..0x10615978, 0x10617ba1..0x10617c47).
    fn recompute_periods(&mut self) -> Result<(), u32> {
        let r = self.player.rate;
        if self.player_mode & 2 != 0 {
            let d = (self.tempo as u32) << 1;
            if d == 0 {
                return Err(UNSUPPORTED_DIVIDE);
            }
            let n = r.wrapping_mul(5);
            let p = ((n / d) << 16).wrapping_add(((n % d) << 16) / d);
            self.player.tick_period = p;
            self.player.voice_period = p;
        } else {
            let d = (self.tempo as u32).wrapping_mul(self.speed as u32);
            if d == 0 {
                return Err(UNSUPPORTED_DIVIDE);
            }
            let n = r.wrapping_mul(60);
            self.player.tick_period = ((n / d) << 16).wrapping_add(((n % d).wrapping_shl(16)) / d);
            let x = (r.wrapping_shl(14) as u64 * 0x10624dd3) >> 32;
            self.player.voice_period = (x >> 4) as u32;
        }
        Ok(())
    }

    // ---- mixer entry 0x10614920 (without the inner kernel) ---------------------

    /// One mixer call for up to `n` frames (clamped to 512); returns frames.
    pub fn mix(&mut self, n: i32) -> Result<i32, u32> {
        let n = if n < 0x200 { n } else { 0x200 };
        let km = self.player.kernel_mode as i32;
        let bus_shift = 1 + (km & 1) + ((km >> 1) & 1);
        let of = self.player.output_format as i32;
        let out_shift = (of & 1) + ((of >> 1) & 1);
        let mut done: i32 = 0;
        self.clear_buses(n, bus_shift as u32);
        if n <= 0 {
            return Ok(0);
        }
        let mut idle = 0u32;
        loop {
            if self.player.ahead == 0 {
                break;
            }
            let mut seg = n.wrapping_sub(done).wrapping_shl(16);
            if self.player.voice_counter < seg {
                seg = self.player.voice_counter & !0xffff;
            }
            if self.player.tick_counter < seg {
                seg = self.player.tick_counter & !0xffff;
            }
            if seg <= 0 {
                idle += 1;
                if idle > 4096 {
                    return Err(UNSUPPORTED_SPIN);
                }
            } else {
                idle = 0;
            }
            if self.mutant(MUTANT_TICK_BEFORE_VOICE_UPDATE) {
                self.tick_part(seg)?;
                self.voice_part(seg)?;
            } else {
                self.voice_part(seg)?;
                self.tick_part(seg)?;
            }
            let frames = seg >> 16;
            if self.player.ahead != 0 {
                let total = self.first_music_voice as usize + self.channels as usize;
                for v in 0..total.min(VOICES) {
                    self.mix_voice(v, frames, done.wrapping_shl(bus_shift as u32), bus_shift as u32)?;
                }
                done = done.wrapping_add(frames);
                self.player.frames_mixed = self.player.frames_mixed.wrapping_add(frames as u32);
                self.player.ahead = self.player.ahead.wrapping_add(frames.wrapping_shl(out_shift as u32) as u32);
            }
            if done >= n {
                break;
            }
        }
        Ok(done)
    }

    /// 0x10614a30..0x10615196: the voice-update countdown.
    fn voice_part(&mut self, seg: i32) -> Result<(), u32> {
        self.player.voice_counter = self.player.voice_counter.wrapping_sub(seg);
        if self.player.voice_counter < 0x10000 {
            self.voice_update()?;
            self.player.voice_counter = self.player.voice_counter.wrapping_add(self.player.voice_period as i32);
            self.trace_state(b'U', false);
        }
        Ok(())
    }

    /// 0x1061519b..0x10615224: the sequencer countdown.
    fn tick_part(&mut self, seg: i32) -> Result<(), u32> {
        self.player.tick_counter = self.player.tick_counter.wrapping_sub(seg);
        if self.player.tick_counter < 0x10000 {
            self.sequencer_tick()?;
            self.post_refills();
            self.ramps();
            self.player.tick_counter = self.player.tick_counter.wrapping_add(self.player.tick_period as i32);
            self.trace_state(b'T', true);
            if let Some(t) = self.player.trace.as_mut() {
                t.groups.push(t.buf.len() as u32);
            }
        }
        Ok(())
    }

    /// 0x106151b0..0x1061520c: stream refill requests for effect voices.
    fn post_refills(&mut self) {
        for v in 0..self.first_music_voice as usize {
            if self.vb(v, 0x10) == 0 || self.vb(v, 0xf) == 0 || self.vb(v, 0x11) & 8 == 0 {
                continue;
            }
            let fmt = self.vw(v, 0x4c);
            if fmt & 0xe000 == 0 && fmt & 0x40 == 0 {
                continue;
            }
            let lparam = self.vd(v, 0x46).wrapping_sub(self.vd(v, 0x52));
            if let Some(t) = self.player.trace.as_mut() {
                let mut p = Vec::with_capacity(12);
                for x in [0x400u32, v as u32, lparam] {
                    p.extend_from_slice(&x.to_le_bytes());
                }
                t.record(b'P', &p);
            }
        }
    }

    /// 0x1061525f..0x106155a1: one voice's segment: pan slew, volume chain,
    /// pan law, then runs cut at the loop/end boundary, each handed to the
    /// inner kernel (recorded) and advanced.
    fn mix_voice(&mut self, v: usize, frames: i32, bus_offset: i32, bus_shift: u32) -> Result<(), u32> {
        if self.vb(v, 0x10) == 0 || self.vb(v, 0xf) == 0 {
            return Ok(());
        }
        let step0 = self.vd(v, 0x62) as i32;
        if step0 == 0 {
            return Ok(());
        }
        let pan_word = self.vw(v, 0x14) as i32;
        let km = self.player.kernel_mode as i32;
        let interpolate = if step0 >= 0x10000 { 0 } else { 2 };
        let mode = ((self.vb(v, 0x4c) as i32 >> 2) & 1) | ((pan_word >> 13) & 4) | (((km >> 1) & 2) & interpolate);
        let music = self.vb(v, 0x11) & 0x80 != 0; // bus group A (0x106152c0)
        let master = if music { self.music_master } else { self.player.sfx_master } as i8 as i32;
        let mm = (master * master) << 1;
        let target = self.vw(v, 0x16) as i32 & 0x7fff;
        let mut d = target - (pan_word & 0x7fff);
        if d != 0 {
            let limit = if self.mutant(MUTANT_PAN_SLEW_256) { 0x100 } else { 0x200 };
            d = d.clamp(-limit, limit);
            self.sw(v, 0x14, (pan_word + d) as u16);
        }
        let p0 = self.vw(v, 0x14) as i32 & 0x7fff;
        let mut t = 0x4000 - (p0 - 0x4000).abs();
        t = t.wrapping_mul(self.vw(v, 0x36) as i16 as i32) >> 15;
        t = t.wrapping_mul(self.vw(v, 0x3c) as i32) >> 15;
        let p = t.wrapping_add(p0);
        let mut vol = (self.vw(v, 0x12) as i32).wrapping_mul(mm) >> 15;
        vol = vol.wrapping_mul(self.vw(v, 0x18) as i32) >> 15;
        vol = vol.wrapping_mul(self.vw(v, 0x1a) as i32) >> 15;
        vol = vol.wrapping_mul(self.vw(v, 0x24) as i16 as i32) >> 15;
        vol = vol.wrapping_mul(self.vw(v, 0x2a) as i32) >> 15;
        vol = vol.wrapping_mul(self.vw(v, 0x66) as i32) >> 15;
        if !(0..=0x7fff).contains(&p) {
            return Err(UNSUPPORTED_PAN);
        }
        let pan = self.player.pan.as_ref().ok_or(UNSUPPORTED_PAN)?;
        let b = (pan[(0x7fff - p) as usize] as i32).wrapping_mul(vol) >> 15;
        let a = (pan[p as usize] as i32).wrapping_mul(vol) >> 15;
        let s1 = self.vw(v, 0x1e) as i32;
        let s2 = self.vw(v, 0x1c) as i32;
        let (s1a, s1b) = (s1.wrapping_mul(a) >> 7, s1.wrapping_mul(b) >> 7);
        let (s2a, s2b) = (s2.wrapping_mul(a) >> 7, s2.wrapping_mul(b) >> 7);
        let mut remaining = frames;
        if remaining == 0 {
            return Ok(());
        }
        let mut offset = bus_offset;
        let mut runs = 0u32;
        loop {
            if self.vb(v, 0xf) == 0 {
                break;
            }
            let fmt = self.vw(v, 0x4c);
            let key_off = self.vb(v, 0xc) & 0x80 != 0;
            let step = self.vd(v, 0x62) as i32;
            let looping = fmt & 8 != 0 && (fmt & 0x80 != 0 || !key_off || step < 0);
            let bound = if looping { self.vd(v, 0x56) } else { self.vd(v, 0x5a) } as i32;
            let pos = self.vd(v, 0x46) as i32;
            let d = bound.wrapping_sub(pos).clamp(-0x7fff, 0x7fff);
            let frac = self.vw(v, 0x4a) as i32;
            let num = d.wrapping_shl(16).wrapping_sub(frac);
            if step == 0 || (num == i32::MIN && step == -1) {
                return Err(UNSUPPORTED_DIVIDE);
            }
            let mut count = num / step;
            if !self.mutant(MUTANT_RUN_WITHOUT_PLUS_ONE) {
                count = count.wrapping_add(1);
            }
            if count >= remaining {
                count = remaining;
            }
            if vol != 0 {
                if let Some(tr) = self.player.trace.as_mut() {
                    let mut k = Vec::with_capacity(60);
                    let off = offset as u32;
                    for x in [v as u32, off, off, off, count as u32, pos as u32, frac as u32, step as u32, b as u32,
                        a as u32, s1b as u32, s1a as u32, s2b as u32, s2a as u32, mode as u32] {
                        k.extend_from_slice(&x.to_le_bytes());
                    }
                    tr.record(b'K', &k);
                }
                self.mix_kernel(music, offset, &[count as u32, pos as u32, frac as u32, step as u32, b as u32, a as u32,
                    s1b as u32, s1a as u32, s2b as u32, s2a as u32, mode as u32])?;
            }
            let t = step.wrapping_mul(count).wrapping_add(frac);
            self.sw(v, 0x4a, t as u16);
            let new_pos = (t >> 16).wrapping_add(pos);
            self.sd(v, 0x46, new_pos as u32);
            let over = if step >= 0 { new_pos.wrapping_sub(bound) } else { bound.wrapping_sub(new_pos) };
            if over >= 0 {
                let fmt = self.vw(v, 0x4c);
                let key_off = self.vb(v, 0xc) & 0x80 != 0;
                if fmt & 8 != 0 && (fmt & 0x80 != 0 || !key_off || step < 0) {
                    if fmt & 0x10 != 0 {
                        let (ls, le) = (self.vd(v, 0x52), self.vd(v, 0x56));
                        self.sd(v, 0x52, le);
                        self.sd(v, 0x56, ls);
                        self.sd(v, 0x62, (step.wrapping_neg()) as u32);
                    }
                    let start = self.vd(v, 0x52);
                    self.sd(v, 0x46, start.wrapping_add(over as u32));
                } else {
                    // The voice ends; +0x11 bit 1 would call [0x1069838c](V, 0, 0),
                    // DX's 0x10604220, which returns 0 without effect then.
                    self.sb(v, 0xf, 0);
                }
            }
            remaining = remaining.wrapping_sub(count);
            offset = offset.wrapping_add(count.wrapping_shl(bus_shift));
            if remaining == 0 {
                break;
            }
            runs += 1;
            if runs > 1 << 20 {
                return Err(UNSUPPORTED_SPIN);
            }
        }
        Ok(())
    }

    // ---- voice update 0x10614a42..0x1061517f -----------------------------------

    fn voice_update(&mut self) -> Result<(), u32> {
        let total = (self.first_music_voice as usize + self.channels as usize).min(VOICES);
        for v in 0..total {
            if self.vb(v, 0xf) == 0 || self.vd(v, 0x20) == 0 {
                continue;
            }
            // Envelopes: volume (block +0x0e), pitch (+0x3e), pan (+0x6e).
            self.envelope(v, 0x0e, 0x2c, 0x28, 0x24, 0x26)?;
            self.envelope(v, 0x3e, 0x2d, 0x30, 0x34, 0x32)?;
            self.envelope(v, 0x6e, 0x3e, 0x3a, 0x36, 0x38)?;
            if self.vb(v, 0xc) & 0x80 != 0 {
                self.key_off(v)?;
            }
            self.porta(v);
            // Vibrato and pitch envelope (0x1061505e..0x106150ee).
            let ph = (self.vw(v, 0x70) as u32 + self.vw(v, 0x72) as u32) & 0xffff;
            let lfo = self.table(((self.vb(v, 0x74) as u32) << 6) + (ph >> 10))?;
            let e = (self.vw(v, 0x2e) as i32).wrapping_mul(self.vw(v, 0x34) as i16 as i32) >> 15;
            let mut p = lfo.wrapping_mul(self.vw(v, 0x6e) as i16 as i32) >> 8;
            p = p.wrapping_add(e).wrapping_add(self.vw(v, 0x80) as i16 as i32).wrapping_add(self.vw(v, 0x6c) as i32);
            let p = p.clamp(0, 0x7800);
            self.sw(v, 0x72, ph as u16);
            self.sw(v, 0x6a, p as u16);
            self.period_to_step(v, p)?;
            // Tremolo (0x106150f3..0x1061515a).
            let ph = (self.vw(v, 0x78) as u32 + self.vw(v, 0x76) as u32) & 0xffff;
            let lfo = self.table(((self.vb(v, 0x75) as u32) << 6) + (ph >> 10))?;
            let x = (lfo.wrapping_mul(self.vw(v, 0x7a) as i16 as i32) >> 8).wrapping_add(self.vw(v, 0x68) as i32);
            self.sw(v, 0x76, ph as u16);
            self.sw(v, 0x66, x.clamp(0, 0x7fff) as u16);
        }
        Ok(())
    }

    /// One envelope pass (volume 0x10614a86, pitch 0x10614b34, pan 0x10614d42);
    /// `f` = block offset of the envelope's flags (count f+2, sustain f+3,
    /// loop start/end f+4/f+5, points (tick, value) at f+6+4i).
    fn envelope(&mut self, v: usize, f: u32, pt: usize, tick: usize, value: usize, delta: usize) -> Result<(), u32> {
        let blk = self.vd(v, 0x20);
        let flags = self.rd8(blk + f)?;
        let points = blk + f + 6;
        if flags & 1 == 0 {
            if f == 0x0e {
                self.sw(v, 0x2a, 0x7fff);
                self.sw(v, value, 0x7fff);
            } else {
                self.sw(v, if f == 0x3e { 0x2e } else { 0x3c }, 0);
                self.sw(v, value, 0);
            }
            return Ok(());
        }
        let i = self.vb(v, pt) as u32;
        if self.vw(v, tick) != self.rd16(points + i * 4)? {
            let x = self.vw(v, value).wrapping_add(self.vw(v, delta));
            self.sw(v, value, x);
            let t = self.vw(v, tick).wrapping_add(1);
            self.sw(v, tick, t);
            return Ok(());
        }
        if flags & 4 != 0 && i as u8 == self.rd8(blk + f + 5)? {
            let j = self.rd8(blk + f + 4)? as u32;
            self.sb(v, pt, j as u8);
            let t = self.rd16(points + j * 4)?;
            self.sw(v, tick, t);
            let x = self.rd16(points + j * 4 + 2)?;
            self.sw(v, value, x);
        }
        let sustain = self.rd8(blk + f + 3)?;
        if self.rd8(blk + f)? & 2 != 0 && self.vb(v, 0xc) & 0x80 == 0 && self.vb(v, pt) == sustain {
            let x = self.rd16(points + sustain as u32 * 4 + 2)?;
            self.sw(v, value, x);
            return Ok(());
        }
        let i = self.vb(v, pt);
        if i >= self.rd8(blk + f + 2)? {
            return Ok(());
        }
        let at = points + i as u32 * 4;
        let val = self.rd16(at + 2)?;
        self.sw(v, value, val);
        let span = (self.rd16(at + 4)? as i32).wrapping_sub(self.vw(v, tick) as i32);
        let diff = (self.rd16(at + 6)? as i16 as i32).wrapping_sub(val as i16 as i32);
        if span == 0 {
            self.sw(v, value, (diff.wrapping_add(val as i32)) as u16);
            self.sw(v, delta, 0);
        } else {
            self.sw(v, delta, (diff / span) as u16);
        }
        self.sb(v, pt, i.wrapping_add(1));
        Ok(())
    }

    /// Key off (0x10614ea8..0x10614fea): with the volume envelope off the
    /// voice stops; otherwise the three fades run (MIDI mode also jumps to
    /// the sustain point).
    fn key_off(&mut self, v: usize) -> Result<(), u32> {
        let blk = self.vd(v, 0x20);
        let tracker = self.player_mode & 2 != 0;
        let mut stop = true;
        if self.rd8(blk + 0x0e)? & 1 != 0 {
            if !tracker {
                let s = self.rd8(blk + 0x11)?;
                if self.vb(v, 0x2c) <= s {
                    self.sb(v, 0x2c, s);
                    let t = self.rd16(blk + s as u32 * 4 + 0x14)?;
                    self.sw(v, 0x28, t);
                }
            }
            let fade = self.rd16(blk + 0x3c)?;
            let x = self.vw(v, 0x2a);
            if x >= fade {
                self.sw(v, 0x2a, x - fade);
                stop = false;
            }
        }
        if stop {
            if !self.mutant(MUTANT_KEY_OFF_KEEPS_VOICE) {
                self.sb(v, 0xf, 0);
            }
            self.sw(v, 0x2a, 0);
        }
        for (f, pt, tick, fade_at, fade_off) in [(0x3e, 0x2d, 0x30, 0x2e, 0x6c), (0x6e, 0x3e, 0x3a, 0x3c, 0x9c)] {
            if self.rd8(blk + f)? & 1 != 0 {
                if !tracker {
                    let s = self.rd8(blk + f + 3)?;
                    if self.vb(v, pt) <= s {
                        self.sb(v, pt, s);
                        let t = self.rd16(blk + f + 6 + s as u32 * 4)?;
                        self.sw(v, tick, t);
                    }
                }
                let fade = self.rd16(blk + fade_off)?;
                let x = self.vw(v, fade_at);
                self.sw(v, fade_at, if x >= fade { x - fade } else { 0 });
            } else {
                self.sw(v, fade_at, 0);
            }
        }
        Ok(())
    }

    /// Porta toward +0x7c by at most +0x7e (0x10614ff1..0x10615057).
    fn porta(&mut self, v: usize) {
        let mut speed = self.vw(v, 0x7e) as i32;
        let (cur, target) = (self.vw(v, 0x6c), self.vw(v, 0x7c));
        if cur < target {
            let diff = target as i32 - cur as i32;
            if diff < speed {
                speed = diff;
            }
            self.sw(v, 0x6c, (cur as i32 + speed) as u16);
        }
        let (cur, target) = (self.vw(v, 0x6c), self.vw(v, 0x7c));
        if cur > target {
            let diff = cur as i32 - target as i32;
            if diff < speed {
                speed = diff;
            }
            self.sw(v, 0x6c, (cur as i32 - speed) as u16);
        }
    }

    /// Frequency for a period (Amiga or linear), then the 16.16 step:
    /// 0x10615660, inline at 0x106172a4 and 0x10617eaf. `p` = 0 keeps the step.
    fn period_to_step(&mut self, v: usize, p: i32) -> Result<(), u32> {
        if p == 0 {
            return Ok(());
        }
        let f: u32 = if self.player_mode & 1 != 0 {
            (0x369de40i32 / p) as u32
        } else {
            let q_hi = ((p as i64 * 0x2aaa_aaab) >> 32) as i32 >> 9;
            let shift = q_hi.wrapping_add(((q_hi as u32) >> 31) as i32).wrapping_add(10) as u8;
            let r = p % 0xc00;
            let idx = if self.mutant(MUTANT_LINEAR_LOW_BITS) { ((r + 2) >> 2).min(767) } else { r >> 2 };
            let lin = self.table((LINEAR as i32 + idx) as u32)? as i64;
            let product = lin.wrapping_mul(self.vd(v, 0x5e) as i64);
            (if shift >= 64 { product >> 63 } else { product >> shift }) as u32
        };
        let r = self.player.rate;
        if r == 0 {
            return Err(UNSUPPORTED_DIVIDE);
        }
        let step = ((f / r) << 16).wrapping_add(((f % r) << 16) / r);
        let step = if self.vd(v, 0x52) > self.vd(v, 0x56) { step.wrapping_neg() } else { step };
        self.sd(v, 0x62, step);
        Ok(())
    }

    // ---- sequencer tick 0x10615710 ---------------------------------------------

    fn sequencer_tick(&mut self) -> Result<(), u32> {
        self.player.tick_count = self.player.tick_count.wrapping_add(1);
        if self.playing == 0 {
            return Ok(());
        }
        let mut ptn = self.pattern;
        let mut walks = 0u32;
        loop {
            if ptn == 0 {
                self.clear_chan();
            } else {
                let tracks = self.rd32(ptn + 8)?;
                let mut finished = true;
                for i in 0..tracks {
                    let trk = ptn + 0xc + 0x1c * i;
                    match self.player_mode & 6 {
                        2 => self.it_track(trk)?,
                        6 => {}
                        _ => return Err(UNSUPPORTED_HANDLER),
                    }
                    if self.rd32(trk + 0x14)? != 0 {
                        finished = false;
                    }
                }
                if !finished {
                    self.pattern = ptn;
                    return Ok(());
                }
                for i in 0..tracks {
                    self.wr32(ptn + 0x14 + 0x1c * i, 0)?;
                }
                ptn = 0;
            }
            // 0x10615860: no current pattern; the callback (0, &pattern, 0)
            // of DX (0x10604220) stores 0 there.
            self.pattern = 0;
            loop {
                walks += 1;
                if walks > 0x400 {
                    return Err(UNSUPPORTED_SPIN); // all orders null or '+++': the original spins
                }
                self.order_position = self.order_position.wrapping_add(1);
                self.break_flag = 0;
                self.row = 0xff;
                if self.order_position == 0 {
                    self.speed = self.initial_speed;
                    self.tempo = self.initial_tempo;
                    self.recompute_periods()?;
                    let first = self.first_music_voice as usize;
                    for ch in 0..self.channels as usize {
                        let pan = (self.initial_pan[ch] as u16) << 8;
                        self.sw(first + ch, 0x16, pan);
                        self.sw(first + ch, 0x14, pan);
                    }
                }
                let o = self.order_position;
                if o <= self.song_length && self.orders[o as usize] != 0xff {
                    let entry = self.orders[o as usize];
                    if entry < 0xfe {
                        ptn = self.pattern_ptr(entry);
                        self.pattern = ptn;
                        if ptn == 0 && self.mutant(MUTANT_NULL_PATTERN_WAITS) {
                            return Ok(());
                        }
                    }
                } else {
                    self.playing = 0;
                    self.order_position = 0xff;
                    if self.loop_flag != 0 {
                        self.playing = 1;
                    } else {
                        ptn = self.pattern; // the callback (0, 0, 0) changes nothing
                    }
                }
                if ptn != 0 {
                    break;
                }
            }
        }
    }

    /// The 'CHAN' records' reset at a tick without a current pattern (0x10615745..0x106157e8).
    fn clear_chan(&mut self) {
        for r in self.player.chan.chunks_mut(CHAN) {
            r.fill(0);
            put32(r, 0, 0x4e41_4843);
            put32(r, 4, 0x29e);
            for (o, x) in [(0x10, 0x200u16), (0x12, 0x40), (0x16, 0x7f), (0x18, 0x64), (0x1c, 0x28), (0x20, 0x3fff), (0x22, 0x3fff)] {
                put16(r, o, x);
            }
        }
    }

    // ---- IT track handler 0x10616eb0 --------------------------------------------

    fn it_track(&mut self, trk: u32) -> Result<(), u32> {
        let mut ptr = self.rd32(trk + 0x14)?;
        let countdown = self.rd32(trk + 0x10)?;
        let saved = self.rd32(trk + 0xc)?;
        let mut count = countdown;
        let mut row_tick = countdown == 0;
        if ptr == 0 {
            self.wr32(trk + 0x10, 0)?;
            ptr = self.rd32(trk + 0x18)?;
            self.wr32(trk + 0x14, ptr)?;
            self.player.last_row = self.rd8(ptr)?;
            ptr = ptr.wrapping_add(1);
            count = 0;
            row_tick = true;
        }
        if row_tick {
            self.tick_in_row = 0;
            count = self.speed as u32;
            if self.player.pattern_delay != 0 {
                self.player.pattern_delay -= 1;
            } else if self.break_flag != 0 || self.row == self.player.last_row {
                ptr = 0; // the pattern ends; effects still run with tick 0 on the old row
            } else {
                let first = self.first_music_voice as usize;
                for ch in 0..self.channels as usize {
                    let v = first + ch;
                    for o in [0x6e, 0x70, 0x7a, 0x78, 0x7e, 0x80] {
                        self.sw(v, o, 0);
                    }
                    self.sb(v, 0x86, 0);
                    self.sb(v, 0x87, 0);
                }
                if self.skip_rows > 1 {
                    loop {
                        loop {
                            let b = self.rd8(ptr)?;
                            ptr = ptr.wrapping_add(1);
                            if b & 0x80 != 0 {
                                ptr = ptr.wrapping_add(2);
                            }
                            if b & 0x40 != 0 {
                                ptr = ptr.wrapping_add(2);
                            }
                            if b & 0x20 != 0 {
                                ptr = ptr.wrapping_add(1);
                            }
                            if b == 0 {
                                break;
                            }
                        }
                        self.skip_rows = self.skip_rows.wrapping_sub(1);
                        self.row = self.row.wrapping_add(1);
                        if self.skip_rows <= 1 {
                            break;
                        }
                    }
                }
                ptr = self.parse_row(ptr)?;
                self.row = self.row.wrapping_add(1);
            }
        }
        self.effects()?;
        if self.tick_in_row == 0 {
            count = self.speed as u32;
        }
        self.tick_in_row = self.tick_in_row.wrapping_add(1);
        self.wr32(trk + 0x14, ptr)?;
        self.wr32(trk + 0x10, count.wrapping_sub(1))?;
        self.wr32(trk + 0xc, saved)?;
        Ok(())
    }

    /// One row of events (0x10616fdd..0x106173ce); returns the read pointer.
    fn parse_row(&mut self, mut ptr: u32) -> Result<u32, u32> {
        loop {
            let flag = self.rd8(ptr)?;
            ptr = ptr.wrapping_add(1);
            let ch = (flag & 0x1f) as usize;
            let v = self.first_music_voice as usize + ch;
            if flag & 0x80 != 0 {
                let param = self.rd8(ptr)?;
                let cmd = self.rd8(ptr + 1)?;
                self.sb(v, 0x87, param);
                self.sb(v, 0x86, cmd);
                ptr = ptr.wrapping_add(2);
            }
            if flag & 0x40 != 0 {
                let inst = self.rd8(ptr)?;
                let note = self.rd8(ptr + 1)?;
                ptr = ptr.wrapping_add(2);
                if inst != 0 {
                    self.sb(v, 0xd, inst - 1);
                    let blk = self.vd(v, 0x20);
                    if blk != 0 {
                        if self.rd8(blk + 0x0e)? & 1 != 0 {
                            self.sw(v, 0x24, 0);
                            self.sw(v, 0x28, 0);
                            self.sw(v, 0x2a, 0x7fff);
                            self.sb(v, 0x2c, 0);
                        }
                        if self.rd8(blk + 0x3e)? & 1 != 0 {
                            self.sw(v, 0x34, 0);
                            self.sw(v, 0x30, 0);
                            self.sw(v, 0x2e, 0x7fff);
                            self.sb(v, 0x2d, 0);
                        }
                        if self.rd8(blk + 0x6e)? & 1 != 0 {
                            self.sw(v, 0x36, 0);
                            self.sw(v, 0x3a, 0);
                            self.sw(v, 0x3c, 0x7fff);
                            self.sb(v, 0x3e, 0);
                        }
                    }
                }
                if note & 0x80 != 0 {
                    self.sb(v, 0xc, note); // key off
                } else if note != 0 {
                    self.sw(v, 0x18, 0x7fff);
                    self.sb(v, 0xc, note - 1);
                    let cmd = self.vb(v, 0x86);
                    let porta = cmd == 3 || cmd == 5 || (cmd == 0xe && self.vb(v, 0x87) & 0xf0 == 0xd0);
                    if !porta {
                        self.trigger(v, ch, note)?;
                    }
                    // Porta target for every note (0x10617349..0x10617388).
                    let k = note as i32 - 1;
                    let mut target = 0u32;
                    if (0..=0x77).contains(&k) {
                        if self.player_mode & 1 != 0 {
                            let c5 = self.vd(v, 0x5e);
                            if c5 != 0 {
                                target = (self.table(AMIGA as u32 + k as u32)? as u32).wrapping_mul(0x20ab) / c5;
                            }
                        } else {
                            target = ((0x78 - k) << 8) as u32;
                        }
                    }
                    self.sw(v, 0x7c, target as u16);
                }
                if inst != 0 {
                    let smp = self.vd(v, 0x42);
                    if smp != 0 {
                        let vol = self.rd16(smp + 0x2a)?;
                        self.sw(v, 0x66, vol);
                        self.sw(v, 0x68, vol);
                    }
                }
            }
            if flag & 0x20 != 0 {
                let vol = (self.rd8(ptr)? as u16) << 8;
                ptr = ptr.wrapping_add(1);
                self.sw(v, 0x66, vol);
                self.sw(v, 0x68, vol);
            }
            if flag == 0 {
                return Ok(ptr);
            }
        }
    }

    /// Sample setup shared by the note trigger (0x10617146..0x10617221) and the
    /// note delay (0x10617d84..0x10617e65), from the instrument at +0x0d and
    /// keymap entry `key`. Returns false where the original stops.
    fn start_sample(&mut self, v: usize, key: u32, music: bool) -> Result<bool, u32> {
        let inst = self.inst_ptr(self.vb(v, 0xd));
        if inst == 0 {
            return Ok(false);
        }
        self.sd(v, 0x20, inst + 0xaa);
        let s = self.rd8(inst + key)?;
        if s as u16 >= self.rd16(inst + 0x148)? {
            return Ok(false);
        }
        let smp = inst + 0x14a + s as u32 * 0x48;
        self.sd(v, 0x42, smp);
        self.sb(v, 0xe, s);
        let mut data = self.rd32(smp + 0x44)?;
        if data == 0 {
            return Ok(false);
        }
        if music {
            self.sb(v, 0x11, 0x80);
        }
        let e = self.rd32(smp + 0x40)?;
        if e != 0 {
            self.sd(v, 0x20, e);
        }
        let kind = self.rd16(smp + 0x2c)?;
        if kind & 4 != 0 {
            data >>= 1;
        }
        self.sw(v, 0x4a, 0);
        self.sd(v, 0x46, data);
        self.sd(v, 0x4e, data);
        let ls = self.rd32(smp + 0x34)?;
        let le = self.rd32(smp + 0x38)?;
        let len = self.rd32(smp + 0x30)?;
        self.sd(v, 0x52, data.wrapping_add(ls));
        self.sd(v, 0x56, data.wrapping_add(le));
        self.sd(v, 0x5a, data.wrapping_add(len));
        let c5 = self.rd32(smp + 0x3c)?;
        self.sd(v, 0x5e, c5);
        self.sw(v, 0x4c, kind);
        if kind & 0x20 != 0 {
            let pan = self.rd16(smp + 0x28)?;
            self.sw(v, 0x16, pan);
            self.sw(v, 0x14, pan);
        }
        let blk = self.vd(v, 0x20);
        let b0 = self.rd8(blk)?;
        self.sb(v, 0x74, b0);
        if b0 & 4 == 0 {
            self.sw(v, 0x72, 0);
        }
        let x = self.rd16(blk + 5)?;
        self.sw(v, 0x70, x);
        let x = self.rd16(blk + 3)?;
        self.sw(v, 0x6e, x);
        let b7 = self.rd8(blk + 7)?;
        self.sb(v, 0x75, b7);
        if b7 & 4 == 0 {
            self.sw(v, 0x76, 0);
        }
        let x = self.rd16(blk + 0xc)?;
        self.sw(v, 0x78, x);
        let x = self.rd16(blk + 0xa)?;
        self.sw(v, 0x7a, x);
        Ok(true)
    }

    /// The note's start period P0 (32 bits; the voice keeps its low word) and step.
    fn start_period(&mut self, v: usize, k: i32) -> Result<(), u32> {
        let mut p0: u32 = 0;
        if (0..=0x77).contains(&k) {
            if self.player_mode & 1 != 0 {
                let c5 = self.vd(v, 0x5e);
                if c5 != 0 {
                    p0 = (self.table(AMIGA as u32 + k as u32)? as u32).wrapping_mul(0x20ab) / c5;
                }
            } else {
                p0 = ((0x78 - k) << 8) as u32;
            }
        }
        self.sw(v, 0x6a, p0 as u16);
        self.sw(v, 0x6c, p0 as u16);
        if p0 != 0 {
            self.period_to_step(v, p0 as i32)?;
        }
        Ok(())
    }

    /// Note trigger (0x106170fd..0x10617346).
    fn trigger(&mut self, v: usize, ch: usize, note: u8) -> Result<(), u32> {
        self.sb(v, 0xf, 0);
        let slot = 0xa2 + CHAN * ch + 4 * note as usize;
        put32(&mut self.player.chan, slot, 0);
        if !self.start_sample(v, 0x29 + note as u32, true)? {
            return Ok(());
        }
        for (o, x) in [(0x24, 0u16), (0x28, 0), (0x2a, 0x7fff), (0x34, 0), (0x30, 0), (0x2e, 0x7fff), (0x36, 0), (0x3a, 0), (0x3c, 0x7fff)] {
            self.sw(v, o, x);
        }
        self.sb(v, 0x2c, 0);
        self.sb(v, 0x2d, 0);
        self.sb(v, 0x3e, 0);
        self.start_period(v, note as i32 - 1)?;
        self.sb(v, 0xf, 1);
        put32(&mut self.player.chan, slot, VOICE_TABLE + (v * VOICE) as u32);
        Ok(())
    }

    /// EDx (0x10617d40): at tick x, start the voice's note +0x0c with
    /// instrument +0x0d; no envelope reset, no +0x11, no slot.
    fn note_delay(&mut self, v: usize) -> Result<(), u32> {
        if self.tick_in_row != (self.vb(v, 0x87) & 0xf) as u16 {
            return Ok(());
        }
        let note = self.vb(v, 0xc);
        if !self.start_sample(v, 0x2a + note as u32, false)? {
            return Ok(());
        }
        self.start_period(v, note as i32)?;
        self.sb(v, 0xf, 1);
        Ok(())
    }

    fn slide(&mut self, v: usize, param: u8) {
        let mut x = param as i32;
        if x > 0xf {
            x = -(x >> 4);
        }
        let vol = (self.vw(v, 0x66) as i32 - (x << 9)).clamp(0, 0x7fff) as u16;
        self.sw(v, 0x66, vol);
        self.sw(v, 0x68, vol);
    }

    /// Merge the nonzero nibbles of `param` into memory byte `o`.
    fn merge(&mut self, v: usize, o: usize, param: u8) {
        if param & 0xf != 0 {
            let m = self.vb(v, o);
            self.sb(v, o, (m & 0xf0) | (param & 0xf));
        }
        if param & 0xf0 != 0 {
            let m = self.vb(v, o);
            self.sb(v, o, (param & 0xf0) | (m & 0xf));
        }
    }

    /// The effect loop over the music voices (0x10617408..0x10617c6e).
    fn effects(&mut self) -> Result<(), u32> {
        let first = self.first_music_voice as usize;
        for v in first..(first + self.channels as usize).min(VOICES) {
            let cmd = self.vb(v, 0x86);
            let x = self.vb(v, 0x87);
            if cmd == 0 && x == 0 {
                continue;
            }
            let t = self.tick_in_row;
            match cmd & 0xf {
                0 => {
                    if t != 0 {
                        let base = self.vw(v, 0x6c) as i32;
                        let r = t as i32 % 3;
                        let (r1, r2) = if self.mutant(MUTANT_ARPEGGIO_SWAP) { (2, 1) } else { (1, 2) };
                        let i = if r == 0 { 0 } else if r == r1 { (x >> 4) as u32 } else if r == r2 { (x & 0xf) as u32 } else { 0 };
                        let m = self.table(ARPEGGIO as u32 + i)?;
                        self.sw(v, 0x80, ((base.wrapping_mul(m) >> 15) - base) as u16);
                    }
                }
                1 | 2 => {
                    if t != 0 {
                        self.sw(v, 0x7e, (x as u16) << 4);
                        let limit = if cmd & 0xf == 1 { self.min_period } else { self.max_period };
                        self.sw(v, 0x7c, limit);
                    }
                }
                3 => {
                    if t == 0 {
                        if x != 0 {
                            self.sb(v, 0x84, x);
                        }
                    } else {
                        self.sw(v, 0x7e, (self.vb(v, 0x84) as u16) << 4);
                    }
                }
                4 => {
                    if t == 0 {
                        self.merge(v, 0x82, x);
                    } else {
                        self.vibrato_from_memory(v);
                    }
                }
                5 => {
                    if t != 0 {
                        self.slide(v, x);
                        self.sw(v, 0x7e, (self.vb(v, 0x84) as u16) << 4);
                    }
                }
                6 => {
                    if t != 0 {
                        self.slide(v, x);
                        self.vibrato_from_memory(v);
                    }
                }
                7 => {
                    if t == 0 {
                        self.merge(v, 0x83, x);
                    } else {
                        let m = self.vb(v, 0x83);
                        self.sw(v, 0x7a, ((m & 0xf) as u16) << 11);
                        self.sw(v, 0x78, (((m >> 2) & 0x3c) as u16) << 8);
                    }
                }
                8 => {
                    if t == 0 {
                        let x = x as i32;
                        let pan = if x > 0x80 {
                            let y = x - 4;
                            if !(0x80..=0xc0).contains(&y) { 0xc0 } else { ((y & 0x7f) << 1).min(0x7f) | 0x80 }
                        } else if x == 0x80 {
                            0x7f
                        } else {
                            x
                        };
                        self.sw(v, 0x16, (pan << 8) as u16);
                        self.sw(v, 0x14, (pan << 8) as u16);
                    }
                }
                9 => {
                    if t == 0 {
                        if x != 0 {
                            self.sb(v, 0x85, x);
                        }
                        let mut pos = self.vd(v, 0x4e).wrapping_add((self.vb(v, 0x85) as u32) << 8);
                        let end = self.vd(v, 0x5a);
                        if pos >= end {
                            pos = end.wrapping_sub(1);
                        }
                        self.sd(v, 0x46, pos);
                        self.sw(v, 0x4a, 0);
                    }
                }
                0xa => {
                    if t != 0 {
                        self.slide(v, x);
                    }
                }
                0xb => {
                    if t == 0 && self.player.pattern_delay == 0 && x <= self.song_length
                        && (self.loop_flag != 0 || x > self.order_position)
                    {
                        self.order_position = x.wrapping_sub(1);
                        self.break_flag = 1;
                    }
                }
                0xc => {
                    if t == 0 {
                        let vol = ((x as u32) << 8).min(0x7fff) as u16;
                        self.sw(v, 0x66, vol);
                        self.sw(v, 0x68, vol);
                    }
                }
                0xd => {
                    if t == 0 && self.player.pattern_delay == 0 {
                        self.skip_rows = (10 * (x >> 4) as u32 + (x & 0xf) as u32 + 1) as u8;
                        self.break_flag = 1;
                    }
                }
                0xe => self.extended(v, x)?,
                _ => {
                    if t == 0 {
                        if x == 0 {
                            self.playing = 0;
                        } else {
                            if x > 0x20 {
                                self.tempo = x as u16;
                            } else {
                                self.speed = x as u16;
                            }
                            self.recompute_periods()?;
                        }
                    }
                }
            }
        }
        Ok(())
    }

    fn vibrato_from_memory(&mut self, v: usize) {
        let m = self.vb(v, 0x82);
        self.sw(v, 0x6e, ((m & 0xf) as u16) << 5);
        self.sw(v, 0x70, (((m >> 2) & 0x3c) as u16) << 8);
    }

    /// Galaxy command E (table 0x10617d00 on param >> 4).
    fn extended(&mut self, v: usize, x: u8) -> Result<(), u32> {
        let t = self.tick_in_row;
        let y = x & 0xf;
        match x >> 4 {
            1 | 2 => {
                if t == 0 {
                    self.sw(v, 0x7e, (y as u16) << 4);
                    let limit = if x >> 4 == 1 { self.min_period } else { self.max_period };
                    self.sw(v, 0x7c, limit);
                } else {
                    self.sw(v, 0x7e, 0);
                }
            }
            4 => self.sb(v, 0x74, x & 7),
            5 => {
                let ft = self.table(FINETUNE as u32 + y as u32)?;
                self.sd(v, 0x5e, (ft.wrapping_mul(0x20ab) >> 15) as u32);
            }
            6 => {
                if t == 0 && self.player.pattern_delay == 0 && self.break_flag == 0 {
                    if y == 0 {
                        self.player.loop_row = self.row;
                    } else {
                        let old = self.player.loop_counter;
                        self.player.loop_counter = old.wrapping_sub(1);
                        if old == 0 {
                            self.player.loop_counter = self.vb(v, 0x87) & 0xf;
                        }
                        if self.player.loop_counter != 0 {
                            self.skip_rows = self.player.loop_row.wrapping_add(1);
                            self.break_flag = 1;
                            self.order_position = self.order_position.wrapping_sub(1);
                        }
                    }
                }
            }
            7 => self.sb(v, 0x75, x & 7),
            8 => {
                let pan = ((y as u16) << 11) + 0x400;
                self.sw(v, 0x16, pan);
                self.sw(v, 0x14, pan);
            }
            9 => {
                if y != 0 && t % y as u16 == 0 {
                    let start = self.vd(v, 0x4e);
                    self.sw(v, 0x4a, 0);
                    self.sd(v, 0x46, start);
                }
            }
            0xa => {
                if t == 0 {
                    let vol = ((self.vw(v, 0x66) as i32) + ((y as i32) << 9)).min(0x7fff) as u16;
                    self.sw(v, 0x66, vol);
                    self.sw(v, 0x68, vol);
                }
            }
            0xb => {
                if t == 0 {
                    let vol = ((self.vw(v, 0x66) as i32) - ((y as i32) << 9)).max(0) as u16;
                    self.sw(v, 0x66, vol);
                    self.sw(v, 0x68, vol);
                }
            }
            0xc => {
                if t as i32 > y as i32 {
                    self.sw(v, 0x66, 0);
                    self.sw(v, 0x68, 0);
                }
            }
            0xd => self.note_delay(v)?,
            0xe => {
                if t == 0 {
                    self.player.pattern_delay = y;
                }
                self.sb(v, 0x87, 0);
                self.sb(v, 0x86, 0);
            }
            _ => {} // E0, E3, EF
        }
        Ok(())
    }

    // ---- ramps 0x10617f50 -------------------------------------------------------

    fn master_ramp(cur: &mut u8, target: u8, step: &mut u8) {
        let (c, t, s) = (*cur as i8 as i32, target as i8 as i32, *step as i8 as i32);
        if t < c {
            if s < t - c {
                *step = target.wrapping_sub(*cur);
            }
        } else if t > c && s > t - c {
            *step = target.wrapping_sub(*cur);
        }
        if target != *cur {
            *cur = cur.wrapping_add(*step);
        }
    }

    fn ramps(&mut self) {
        let (mut cur, mut step) = (self.music_master, self.player.music_step);
        Self::master_ramp(&mut cur, self.player.music_target, &mut step);
        self.music_master = cur;
        self.player.music_step = step;
        let (mut cur, mut step) = (self.player.sfx_master, self.player.sfx_step);
        Self::master_ramp(&mut cur, self.player.sfx_target, &mut step);
        self.player.sfx_master = cur;
        self.player.sfx_step = step;
        let total = (self.first_music_voice as usize + self.channels as usize).min(VOICES);
        for v in 0..total {
            let (t, c, s) = (self.vb(v, 0x41), self.vb(v, 0x3f), self.vb(v, 0x40) as i8 as i32);
            let d = t as i32 - c as i32;
            if (t < c && s < d) || (t > c && s > d) {
                self.sb(v, 0x40, t.wrapping_sub(c));
            }
            if self.vb(v, 0x3f) != self.vb(v, 0x41) {
                let x = self.vb(v, 0x40).wrapping_add(self.vb(v, 0x3f));
                self.sb(v, 0x3f, x);
            }
            let c = self.vb(v, 0x3f) as u32;
            self.sw(v, 0x12, (c * c * 2) as u16);
        }
    }

    // ---- trace ------------------------------------------------------------------

    fn globals_into(&self, o: &mut Vec<u8>) {
        let p = &self.player;
        o.extend_from_slice(&[self.channels, self.playing, self.song_length, self.first_music_voice, self.player_mode]);
        o.extend_from_slice(&[self.order_position, self.row, p.last_row]);
        for w in [self.tick_in_row, self.speed, self.tempo, self.initial_speed, self.initial_tempo] {
            o.extend_from_slice(&w.to_le_bytes());
        }
        o.extend_from_slice(&[p.pattern_delay, self.break_flag, self.skip_rows, self.loop_flag]);
        o.extend_from_slice(&self.pattern.to_le_bytes());
        o.extend_from_slice(&[p.loop_row, p.loop_counter]);
        o.extend_from_slice(&self.min_period.to_le_bytes());
        o.extend_from_slice(&self.max_period.to_le_bytes());
        o.extend_from_slice(&[self.music_master, p.music_target, p.music_step, p.sfx_master, p.sfx_target, p.sfx_step]);
        for d in [p.tick_count, p.voice_counter as u32, p.voice_period, p.tick_counter as u32, p.tick_period, p.rate,
            p.frames_mixed, p.ahead] {
            o.extend_from_slice(&d.to_le_bytes());
        }
        o.extend_from_slice(&[p.kernel_mode, p.output_format]);
    }

    fn trace_state(&mut self, tag: u8, tick: bool) {
        if self.player.trace.is_none() {
            return;
        }
        let mut o = Vec::with_capacity(0x1400);
        self.globals_into(&mut o);
        if tick {
            if self.pattern != 0 {
                o.push(1);
                match self.rd(self.pattern, 0x28) {
                    Ok(h) => o.extend_from_slice(h),
                    Err(_) => o.extend_from_slice(&[0; 0x28]),
                }
            } else {
                o.push(0);
            }
        }
        let first = self.first_music_voice as usize;
        let end = (first + self.channels as usize).min(VOICES);
        o.extend_from_slice(&self.voices[first * VOICE..end * VOICE]);
        self.player.trace.as_mut().unwrap().record(tag, &o);
    }

    fn trace_record(&mut self, tag: u8, words: &[u32]) {
        if let Some(t) = self.player.trace.as_mut() {
            let mut p = Vec::with_capacity(4 * words.len());
            for w in words {
                p.extend_from_slice(&w.to_le_bytes());
            }
            t.record(tag, &p);
        }
    }

    /// 'E': all voices, the CHAN records, every pattern header; closes the last group.
    pub fn trace_end(&mut self) {
        if self.player.trace.is_none() {
            return;
        }
        let mut o = self.voices.clone();
        o.extend_from_slice(&self.player.chan);
        for (p, pattern) in self.patterns.iter().enumerate() {
            if let Some(pattern) = pattern {
                o.extend_from_slice(&(p as u16).to_le_bytes());
                o.extend_from_slice(&pattern.header);
            }
        }
        let t = self.player.trace.as_mut().unwrap();
        t.record(b'E', &o);
        t.groups.push(t.buf.len() as u32);
    }

    /// One 20 ms timer callback: the ring fill is pinned, then mixer calls
    /// for the remaining frames until all are rendered ('M'/'R' around each).
    pub fn callback(&mut self) -> Result<(), u32> {
        self.player.ahead = self.player.ahead_pin;
        let mut remaining = CALLBACK_FRAMES;
        while remaining != 0 {
            self.trace_record(b'M', &[remaining as u32]);
            let k = self.mix(remaining)?;
            self.trace_record(b'R', &[k as u32]);
            if k == 0 {
                return Err(UNSUPPORTED_SPIN);
            }
            remaining -= k;
        }
        Ok(())
    }
}

// ---- Wasm exports -------------------------------------------------------------

fn with_library<R>(f: impl FnOnce(&mut Library) -> R) -> R {
    LIBRARY.with(|l| f(&mut l.borrow_mut()))
}

/// glxInit's tail, glxSetCallback and the output open as DX runs them on the
/// reference machine (44100 Hz, 16-bit stereo, flags 7, SSE); `pc` = x87 PC bits.
#[no_mangle]
pub extern "C" fn galaxy_seq_setup(pc: u32) -> u32 {
    with_library(|l| l.setup_output(pc, [1, 1, 0], 44100, 2, 16, 7))
}

#[no_mangle]
pub extern "C" fn galaxy_seq_trace(enable: u32) {
    with_library(|l| l.player.trace = if enable != 0 { Some(Trace { buf: Vec::new(), groups: Vec::new() }) } else { None });
}

/// Update's load: SetVolumes' library calls (sample 127, music 76 at the
/// installed volumes), glxLoadMusic on the input buffer, the setters again.
#[no_mangle]
pub extern "C" fn galaxy_seq_load(len: u32, sample_volume: i32, music_volume: i32) -> u32 {
    INPUT.with(|i| {
        let input = i.borrow();
        with_library(|l| {
            l.set_sample_volume(sample_volume, 0);
            l.set_music_volume(music_volume, 0);
            let status = l.load_music(&input, len);
            l.set_sample_volume(sample_volume, 0);
            l.set_music_volume(music_volume, 0);
            l.trace_record(b'L', &[status]);
            status
        })
    })
}

/// UnregisterMusic's library calls: glxStopMusic, glxUnloadMusic.
#[no_mangle]
pub extern "C" fn galaxy_seq_unload() -> u32 {
    with_library(|l| {
        let a = l.stop_music();
        let b = l.unload_music();
        l.trace_record(b'S', &[a, b]);
        b
    })
}

#[no_mangle]
pub extern "C" fn galaxy_seq_start(effects_channels: u32, section: u32) -> u32 {
    with_library(|l| {
        let r = l.update_start(effects_channels as usize, section as u8);
        l.trace_record(b'S', &r);
        r[2]
    })
}

#[no_mangle]
pub extern "C" fn galaxy_seq_pin(voice_counter: u32, tick_counter: u32) {
    with_library(|l| {
        l.player.voice_counter = voice_counter as i32;
        l.player.tick_counter = tick_counter as i32;
    });
}

#[no_mangle]
pub extern "C" fn galaxy_seq_ahead(value: u32) {
    with_library(|l| l.player.ahead_pin = value);
}

/// Run `count` timer callbacks; 0, or the fault that stopped them.
#[no_mangle]
pub extern "C" fn galaxy_seq_callbacks(count: u32) -> u32 {
    with_library(|l| {
        if l.player.fault != 0 {
            return l.player.fault;
        }
        for _ in 0..count {
            if let Err(e) = l.callback() {
                l.player.fault = e;
                return e;
            }
        }
        0
    })
}

#[no_mangle]
pub extern "C" fn galaxy_seq_end() {
    with_library(|l| l.trace_end());
}

#[no_mangle]
pub extern "C" fn galaxy_trace_ptr() -> *const u8 {
    with_library(|l| l.player.trace.as_ref().map_or(std::ptr::null(), |t| t.buf.as_ptr()))
}

#[no_mangle]
pub extern "C" fn galaxy_trace_len() -> u32 {
    with_library(|l| l.player.trace.as_ref().map_or(0, |t| t.buf.len() as u32))
}

#[no_mangle]
pub extern "C" fn galaxy_trace_groups_ptr() -> *const u32 {
    with_library(|l| l.player.trace.as_ref().map_or(std::ptr::null(), |t| t.groups.as_ptr()))
}

#[no_mangle]
pub extern "C" fn galaxy_trace_groups_len() -> u32 {
    with_library(|l| l.player.trace.as_ref().map_or(0, |t| t.groups.len() as u32))
}

/// Drop the trace bytes of every closed group (JS has hashed them).
#[no_mangle]
pub extern "C" fn galaxy_trace_consume() {
    with_library(|l| {
        if let Some(t) = l.player.trace.as_mut() {
            if let Some(&end) = t.groups.last() {
                t.buf.drain(..end as usize);
            }
            t.groups.clear();
        }
    });
}

/// The pan table the model computes under precision control `pc`.
#[no_mangle]
pub extern "C" fn galaxy_pan_table_ptr(pc: u32) -> *const i16 {
    PAN_KEEP.with(|k| {
        let t = pan_table(pc);
        let ptr = t.as_ptr();
        k.borrow_mut().push(t);
        ptr
    })
}

/// The .rdata tables 0x1063daa0..0x1063ec00 as generated (1112 dwords).
#[no_mangle]
pub extern "C" fn galaxy_tables_ptr() -> *const i32 {
    TABLES.with(|t| t.as_ptr())
}

thread_local! {
    static PAN_KEEP: RefCell<Vec<Rc<Vec<i16>>>> = const { RefCell::new(Vec::new()) };
}
