//! Galaxy's DirectSound output: the winmm timer callback 0x106142a0 that
//! places the renderer's two buses in the staging ring [0x10697ccc] and
//! copies them into the secondary buffer [0x10697cc8], translated from
//! Galaxy.dll (GOTY, preferred base 0x10600000).
//!
//! Contract: docs/galaxy-music/mixer.md §1.3 and docs/audio-output-scope.md
//! §2.2 (the disassembly of 0x106142a0..0x10614693). Verified against the
//! original callback under Unicorn with a scripted secondary buffer
//! (scripts/native-galaxy-output-oracle.py, scripts/validate-galaxy-output-callback.mjs).
//! Integer code only: `div`, `mul 0x10624dd3`, `shr 6`; no x87 or SSE outside
//! the renderer (render_ring, mixer.rs).
//!
//! The secondary buffer is the host's (DirectSound, or Wine's dsound on the
//! reference machine). `Secondary` models the five methods the callback
//! calls: GetCurrentPosition answers the cursor pair the host sets; Lock
//! splits a range at the buffer's end as DirectSound does for a looping
//! buffer (a host model, labelled: Wine's `IDirectSoundBufferImpl_Lock`
//! split, not measured); Unlock, Play and Restore have no effect on the
//! bytes. A validator can script each Lock's result (DSERR_BUFFERLOST, any
//! failure) and GetCurrentPosition's, and log every call.
use super::*;
use std::collections::VecDeque;

pub const DS_OK: u32 = 0;
pub const DSERR_BUFFERLOST: u32 = 0x8878_0096; // compared at 0x106143da, 0x106144d0, 0x106145a8
pub const DSERR_INVALIDPARAM: u32 = 0x8007_0057; // the host model's answer to an impossible range
pub const DSBLOCK_ENTIREBUFFER: u32 = 2; // the resync's Lock flags (0x106143bf)
pub const DSBPLAY_LOOPING: u32 = 1; // Play after Restore (0x106143f1)
/// A Lock region pointer that is NULL (the second region of an unsplit lock).
pub const NULL_REGION: u32 = 0xffff_ffff;

// The call log (validator): each call's words, the first being the method.
pub const CALL_POSITION: u32 = 1; // [1, hr, play, write]
pub const CALL_LOCK: u32 = 2; // [2, offset, bytes, flags, hr, p1, b1, p2, b2] (pointers as buffer offsets)
pub const CALL_UNLOCK: u32 = 3; // [3, p1, b1, p2, b2]
pub const CALL_PLAY: u32 = 4; // [4, reserved, priority, flags]
pub const CALL_RESTORE: u32 = 5; // [5]

// Faults: the original would read or write outside its blocks there.
pub const UNSUPPORTED_OUTPUT_COPY: u32 = 0x140; // a copy past the staging ring or the secondary buffer
pub const UNSUPPORTED_OUTPUT_SIZE: u32 = 0x141; // ring size 0 or odd (div by 0; render_ring's int16 ring)
pub const UNSUPPORTED_3D_VOICES: u32 = 0x142; // 0x106126f0 with a hardware 3D type (A3D/EAX), not translated

// Test-only translation mutants (validate-galaxy-output-callback.mjs).
pub const MUTANT_NO_CURSOR_MASK: u32 = 401; // play/target not masked with ~(nBlockAlign - 1)
pub const MUTANT_RESYNC_RETURNS: u32 = 402; // the resync returns instead of continuing into the normal render
pub const MUTANT_AHEAD_UNSIGNED: u32 = 403; // `ahead <= 0` tested unsigned (only 0 resyncs)
pub const MUTANT_NO_LOST_RETRY: u32 = 404; // DSERR_BUFFERLOST not retried after Restore/Play
pub const MUTANT_RESEAT_ONCE: u32 = 405; // the A == B re-seat only at the first callback

/// The secondary buffer's model (see the module comment).
pub struct Secondary {
    /// The buffer's bytes (nAvgBytesPerSec of them, CreateSoundBuffer at
    /// 0x10613841), held as int16 so the host can read the frames in place.
    pub data: Vec<i16>,
    /// What the next GetCurrentPosition answers.
    pub play: u32,
    pub write: u32,
    pub position_hr: u32,
    /// Scripted Lock results in call order (validator); DS_OK once empty.
    pub lock_hr: VecDeque<u32>,
    pub log: Option<Vec<u32>>,
}

#[derive(Clone, Copy)]
struct Region {
    p1: u32,
    b1: u32,
    p2: u32,
    b2: u32,
}

impl Secondary {
    fn new() -> Self {
        Secondary { data: Vec::new(), play: 0, write: 0, position_hr: DS_OK, lock_hr: VecDeque::new(), log: None }
    }

    fn log(&mut self, words: &[u32]) {
        if let Some(l) = self.log.as_mut() {
            l.extend_from_slice(words);
        }
    }

    fn get_current_position(&mut self) -> (u32, u32, u32) {
        let (hr, play, write) = (self.position_hr, self.play, self.write);
        self.position_hr = DS_OK;
        self.log(&[CALL_POSITION, hr, play, write]);
        (hr, play, write)
    }

    /// Lock(offset, bytes, &p1, &b1, &p2, &b2, flags): ENTIREBUFFER takes the
    /// whole buffer; a range past the end wraps into a second region at 0.
    fn lock(&mut self, offset: u32, bytes: u32, flags: u32) -> (u32, Region) {
        let len = 2 * self.data.len() as u32;
        let mut hr = self.lock_hr.pop_front().unwrap_or(DS_OK);
        let mut r = Region { p1: NULL_REGION, b1: 0, p2: NULL_REGION, b2: 0 };
        if hr == DS_OK {
            let bytes = if flags & DSBLOCK_ENTIREBUFFER != 0 { len } else { bytes };
            if offset >= len || bytes > len {
                hr = DSERR_INVALIDPARAM;
            } else if offset + bytes <= len {
                r = Region { p1: offset, b1: bytes, p2: NULL_REGION, b2: 0 };
            } else {
                r = Region { p1: offset, b1: len - offset, p2: 0, b2: bytes - (len - offset) };
            }
        }
        self.log(&[CALL_LOCK, offset, bytes, flags, hr, r.p1, r.b1, r.p2, r.b2]);
        (hr, r)
    }

    fn unlock(&mut self, r: Region) {
        self.log(&[CALL_UNLOCK, r.p1, r.b1, r.p2, r.b2]);
    }

    fn restore(&mut self) {
        self.log(&[CALL_RESTORE]);
    }

    fn play_looping(&mut self, reserved: u32, priority: u32, flags: u32) {
        self.log(&[CALL_PLAY, reserved, priority, flags]);
    }
}

/// The output's globals and blocks.
pub struct Output {
    pub size: u32,        // 0x10697cd0, the ring size (nAvgBytesPerSec)
    pub head_a: u32,      // 0x10697cd4, bus A (music)
    pub head_b: u32,      // 0x10697cd8, bus B (effects, speech)
    pub avg_bytes: u32,   // 0x1067b6e0, WAVEFORMATEX nAvgBytesPerSec
    pub align_word: u32,  // the dword at 0x1067b6e4: nBlockAlign | wBitsPerSample << 16
    pub latency: u32,     // 0x1064a65c, clamp(Latency, 5, 495)
    /// [0x10697ccc]: the staging ring, `size` bytes as int16 (glxInit's
    /// GlobalAlloc block is 0x2ee00 bytes; the callback uses the first `size`).
    pub staging: Vec<i16>,
    pub secondary: Secondary,
    /// The last normal render's byte count (R), or NULL_REGION if none ran (validator).
    pub last_render: u32,
    /// Callbacks past GetCurrentPosition, and resyncs among them (host diagnostics).
    pub callbacks: u32,
    pub resyncs: u32,
}

impl Output {
    pub(crate) fn new() -> Self {
        Output { size: 0, head_a: 0, head_b: 0, avg_bytes: 0, align_word: 0, latency: 0x28, staging: Vec::new(),
            secondary: Secondary::new(), last_render: NULL_REGION, callbacks: 0, resyncs: 0 }
    }
}

fn bytes_of(v: &[i16]) -> &[u8] {
    // SAFETY: i16 has no padding and any byte pattern is valid; little-endian
    // on every target the kernel runs on (wasm32, x86).
    unsafe { std::slice::from_raw_parts(v.as_ptr() as *const u8, v.len() * 2) }
}

fn bytes_of_mut(v: &mut [i16]) -> &mut [u8] {
    // SAFETY: as bytes_of; the borrow is unique.
    unsafe { std::slice::from_raw_parts_mut(v.as_mut_ptr() as *mut u8, v.len() * 2) }
}

impl Library {
    /// The output open's DirectSound buffer setup for 16-bit stereo at
    /// `rate`, after `setup_output` (the open's tail): the latency store
    /// (0x106133f5..0x10613420, clamped to 5..495), the ring size
    /// `[0x10697cd0] = nAvgBytesPerSec` (0x10613943), the 1-second secondary
    /// buffer (zeroed: the host's fresh buffer) and the staging ring silenced
    /// (0x1061384f..0x10613884: fill `(wBitsPerSample & 8) << 4`, 0 for
    /// 16-bit), the heads and `ahead` zeroed (0x1061396c..0x1061399c).
    pub fn open_output(&mut self, rate: u32, latency: u32) -> u32 {
        let o = &mut self.player.output;
        o.latency = latency.clamp(5, 495);
        o.avg_bytes = rate * 4;
        o.align_word = 4 | 16 << 16;
        o.size = o.avg_bytes;
        o.head_a = 0;
        o.head_b = 0;
        o.staging = vec![0; (o.size / 2) as usize];
        o.secondary.data = vec![0; (o.size / 2) as usize];
        o.last_render = NULL_REGION;
        o.callbacks = 0;
        o.resyncs = 0;
        self.player.ahead = 0;
        OK
    }

    /// 0x106126f0, the hardware 3D voice poll: for each effect slot with a
    /// buffer at `V+0x88` and `V+0x11 & 4`, a status query when the 3D type
    /// [0x1069817a] is 2..5 (A3D 1.x, EAX 1.x, A3D 2.x, EAX 2.x). The model
    /// has no 3D type (the reference machine's Init leaves it 0, scope §2.6):
    /// nothing happens. `V+0x88` is a ring voice's write position too (its
    /// 0x10000 sentinel passes the first test; `V+0x11` is 8 for a 2D start,
    /// so the second drops it).
    fn poll_3d_voices(&mut self) -> Result<(), u32> {
        Ok(())
    }

    /// render_ring on the staging ring.
    fn render_staging(&mut self, pos_a: u32, pos_b: u32, len_a: i32, len_b: i32) -> Result<i32, u32> {
        let size = self.player.output.size as usize;
        let mut staging = std::mem::take(&mut self.player.output.staging);
        let r = self.render_ring(&mut staging[..size / 2], pos_a as i32, pos_b as i32, len_a, len_b);
        self.player.output.staging = staging;
        r
    }

    /// Lock, and on DSERR_BUFFERLOST Restore, Play(0, 0, LOOPING) and Lock
    /// again (0x106143da..0x1061441e, 0x106144d0..0x10614519, 0x106145a8..0x106145f1).
    fn lock_retry(&mut self, offset: u32, bytes: u32, flags: u32) -> (u32, Region) {
        let no_retry = self.mutant(MUTANT_NO_LOST_RETRY);
        let s = &mut self.player.output.secondary;
        let (hr, r) = s.lock(offset, bytes, flags);
        if hr != DSERR_BUFFERLOST || no_retry {
            return (hr, r);
        }
        s.restore();
        s.play_looping(0, 0, DSBPLAY_LOOPING);
        s.lock(offset, bytes, flags)
    }

    /// `rep movsd; rep movsb` of `n` staging bytes from `from` into the
    /// secondary buffer at `to`.
    fn copy_out(&mut self, from: u32, to: u32, n: u32) -> Result<(), u32> {
        if n == 0 {
            return Ok(());
        }
        let o = &mut self.player.output;
        let (from, to, n) = (from as usize, to as usize, n as usize);
        if to == NULL_REGION as usize || from + n > o.size as usize || to + n > 2 * o.secondary.data.len() {
            return Err(UNSUPPORTED_OUTPUT_COPY);
        }
        let src = &bytes_of(&o.staging)[from..from + n];
        bytes_of_mut(&mut o.secondary.data)[to..to + n].copy_from_slice(src);
        Ok(())
    }

    /// The timer callback 0x106142a0 (stdcall, the winmm TIMECALLBACK's five
    /// dwords, all unused), under the library lock 0x1067b670.
    pub fn output_callback(&mut self) -> Result<(), u32> {
        self.player.output.last_render = NULL_REGION;
        if self.player.output_open == 0 {
            return Ok(()); // 0x106142a3..0x106142aa
        }
        // EnterCriticalSection(0x1067b670) 0x106142b9: the host applies the
        // game thread's library calls between callbacks.
        self.poll_3d_voices()?;
        let (hr, play, write) = self.player.output.secondary.get_current_position();
        if hr != DS_OK {
            return Ok(()); // 0x106142db: straight to LeaveCriticalSection
        }
        self.player.output.callbacks += 1;
        let (no_mask, reseat_once) = (self.mutant(MUTANT_NO_CURSOR_MASK), self.mutant(MUTANT_RESEAT_ONCE));
        let o = &mut self.player.output;
        let size = o.size;
        if size == 0 || size & 1 != 0 {
            return Err(UNSUPPORTED_OUTPUT_SIZE);
        }
        // 0x106142e1..0x1061433a: mask = ~((nBlockAlign & 0xffff) - 1);
        // latency bytes = (nAvgBytesPerSec * Latency) / 1000 as mul 0x10624dd3, shr 6.
        let mask = if no_mask { !0 } else { !((o.align_word & 0xffff).wrapping_sub(1)) };
        let play = (play % size) & mask;
        let product = o.avg_bytes.wrapping_mul(o.latency);
        let latency_bytes = ((product as u64 * 0x1062_4dd3) >> 32) as u32 >> 6;
        let target = ((write % size).wrapping_add(latency_bytes) % size) & mask;
        // 0x1061433c..0x1061434e: coincident heads (the open zeroes both) take the cursors.
        if o.head_a == o.head_b && (!reseat_once || o.callbacks == 1) {
            o.head_a = play;
            o.head_b = target;
        }
        let (a, b) = (o.head_a, o.head_b);
        // 0x10614353..0x1061437b: the lengths each cursor moved, ahead -= the smaller.
        let mut len_a = play.wrapping_sub(a) as i32;
        if len_a < 0 {
            len_a = len_a.wrapping_add(size as i32);
        }
        let mut len_b = target.wrapping_sub(b) as i32;
        if len_b < 0 {
            len_b = len_b.wrapping_add(size as i32);
        }
        let consumed = if len_a < len_b { len_a } else { len_b };
        let ahead = (self.player.ahead as i32).wrapping_sub(consumed);
        self.player.ahead = ahead as u32;
        let resync = if self.mutant(MUTANT_AHEAD_UNSIGNED) { ahead == 0 } else { ahead <= 0 };
        if resync {
            // 0x10614387..0x10614471: ahead = (B - A) mod size; both buses at B
            // over (A - B) mod size bytes; the whole buffer locked and the
            // whole staging ring copied.
            let mut n = a.wrapping_sub(b) as i32;
            if n < 0 {
                n = n.wrapping_add(size as i32);
            }
            let mut fill = b.wrapping_sub(a) as i32;
            if fill < 0 {
                fill = fill.wrapping_add(size as i32);
            }
            self.player.ahead = fill as u32;
            self.player.output.resyncs += 1;
            self.render_staging(b, b, n, n)?;
            let (hr, r) = self.lock_retry(0, size, DSBLOCK_ENTIREBUFFER);
            if hr == DS_OK {
                self.copy_out(0, r.p1, size)?;
                self.player.output.secondary.unlock(Region { p1: r.p1, b1: r.b1, p2: NULL_REGION, b2: 0 });
            }
            if self.mutant(MUTANT_RESYNC_RETURNS) {
                return Ok(());
            }
        }
        // 0x10614484..0x1061448c: the normal render, unless nothing is ahead.
        if self.player.ahead == 0 {
            return Ok(());
        }
        let rendered = self.render_staging(a, b, len_a, len_b)? as u32;
        self.player.output.last_render = rendered;
        // 0x106144a5..0x10614654: Lock(head, R) and copy, A then B; the
        // second region's bytes come from the start of the staging ring.
        for head in [a, b] {
            let (hr, r) = self.lock_retry(head, rendered, 0);
            if hr == DS_OK {
                self.copy_out(head, r.p1, r.b1)?;
                self.copy_out(0, r.p2, r.b2)?;
                self.player.output.secondary.unlock(r);
            }
        }
        // 0x10614657..0x1061467b: both heads advance by R (unsigned div).
        let o = &mut self.player.output;
        o.head_a = o.head_a.wrapping_add(rendered) % size;
        o.head_b = o.head_b.wrapping_add(rendered) % size;
        Ok(())
        // LeaveCriticalSection(0x1067b670) 0x10614686.
    }
}

// ---- Wasm exports -------------------------------------------------------------

fn with_library<R>(f: impl FnOnce(&mut Library) -> R) -> R {
    LIBRARY.with(|l| f(&mut l.borrow_mut()))
}

/// The DirectSound buffer setup after the open's tail (`open_output`), at
/// 44100 Hz with `latency` ms (DeusEx.ini Latency after Init's clamp).
#[no_mangle]
pub extern "C" fn galaxy_output_open(latency: u32) -> u32 {
    with_library(|l| {
        let rate = l.player.rate;
        l.open_output(rate, latency)
    })
}

/// One timer callback with GetCurrentPosition answering (play, write).
/// Returns 0, or the fault (also galaxy_fault).
#[no_mangle]
pub extern "C" fn galaxy_output_callback(play: u32, write: u32) -> u32 {
    with_library(|l| {
        if l.player.fault != 0 {
            return l.player.fault;
        }
        l.player.output.secondary.play = play;
        l.player.output.secondary.write = write;
        match l.output_callback() {
            Ok(()) => 0,
            Err(e) => {
                l.player.fault = e;
                e
            }
        }
    })
}

/// The secondary buffer's bytes (the output the host plays: interleaved
/// int16 stereo frames, `size` bytes).
#[no_mangle]
pub extern "C" fn galaxy_output_secondary() -> *const i16 {
    with_library(|l| l.player.output.secondary.data.as_ptr())
}

/// The staging ring [0x10697ccc] (validator).
#[no_mangle]
pub extern "C" fn galaxy_output_staging() -> *const i16 {
    with_library(|l| l.player.output.staging.as_ptr())
}

/// Ring size, head A, head B, ahead, the last R (NULL_REGION if none), callbacks, resyncs.
#[no_mangle]
pub extern "C" fn galaxy_output_state(index: u32) -> u32 {
    with_library(|l| {
        let o = &l.player.output;
        match index {
            0 => o.size,
            1 => o.head_a,
            2 => o.head_b,
            3 => l.player.ahead,
            4 => o.last_render,
            5 => o.callbacks,
            6 => o.resyncs,
            _ => 0,
        }
    })
}

/// Validator: the next GetCurrentPosition's result.
#[no_mangle]
pub extern "C" fn galaxy_output_position_result(hr: u32) {
    with_library(|l| l.player.output.secondary.position_hr = hr);
}

/// Validator: append one Lock result to the script.
#[no_mangle]
pub extern "C" fn galaxy_output_lock_result(hr: u32) {
    with_library(|l| l.player.output.secondary.lock_hr.push_back(hr));
}

/// Validator: start (1) or stop (0) logging the secondary buffer's calls; a start clears the log.
#[no_mangle]
pub extern "C" fn galaxy_output_log(enable: u32) {
    with_library(|l| l.player.output.secondary.log = if enable != 0 { Some(Vec::new()) } else { None });
}

#[no_mangle]
pub extern "C" fn galaxy_output_log_ptr() -> *const u32 {
    with_library(|l| l.player.output.secondary.log.as_ref().map_or(std::ptr::null(), |v| v.as_ptr()))
}

#[no_mangle]
pub extern "C" fn galaxy_output_log_len() -> u32 {
    with_library(|l| l.player.output.secondary.log.as_ref().map_or(0, |v| v.len() as u32))
}

#[no_mangle]
pub extern "C" fn galaxy_output_log_clear() {
    with_library(|l| {
        if let Some(v) = l.player.output.secondary.log.as_mut() {
            v.clear();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn library() -> Library {
        let mut l = Library::new(16);
        assert_eq!(l.setup_output(64, [1, 1, 0], 44100, 2, 16, 7), OK);
        assert_eq!(l.open_output(44100, 40), OK);
        l.player.output.secondary.log = Some(Vec::new());
        l
    }

    /// The first callback: heads seated at (play, write + 7056), the resync
    /// renders (A - B) mod size bytes at B, the whole buffer is copied, then
    /// the normal render of 0 bytes still locks both heads.
    #[test]
    fn first_callback() {
        let mut l = library();
        l.player.output.secondary.play = 1000;
        l.player.output.secondary.write = 1000 + 1764;
        l.output_callback().unwrap();
        let o = &l.player.output;
        assert_eq!((o.head_a, o.head_b), (1000, 1000 + 1764 + 7056));
        assert_eq!(l.player.ahead, 176400);
        assert_eq!(o.last_render, 0);
        let log = o.secondary.log.as_ref().unwrap();
        assert_eq!(&log[..4], &[CALL_POSITION, 0, 1000, 2764]);
        assert_eq!(&log[4..13], &[CALL_LOCK, 0, 176400, 2, 0, 0, 176400, NULL_REGION, 0]);
        assert_eq!(&log[13..18], &[CALL_UNLOCK, 0, 176400, NULL_REGION, 0]);
        assert_eq!(&log[18..27], &[CALL_LOCK, 1000, 0, 0, 0, 1000, 0, NULL_REGION, 0]);
    }

    /// Steady state: R = min(lenA, lenB); both heads advance by R; a range
    /// past the end splits into two regions, the second copied from the
    /// staging ring's start.
    #[test]
    fn wrap_split() {
        let mut l = library();
        l.player.output.secondary.play = 176400 - 3528;
        l.player.output.secondary.write = 176400 - 3528;
        l.output_callback().unwrap();
        l.player.output.secondary.log = Some(Vec::new());
        l.player.output.secondary.play = 1764;
        l.player.output.secondary.write = 1764;
        l.output_callback().unwrap();
        let o = &l.player.output;
        assert_eq!(o.last_render, 5292);
        assert_eq!((o.head_a, o.head_b), (1764, 1764 + 7056));
        let log = o.secondary.log.as_ref().unwrap();
        assert_eq!(&log[4..13], &[CALL_LOCK, 176400 - 3528, 5292, 0, 0, 176400 - 3528, 3528, 0, 1764]);
    }
}
