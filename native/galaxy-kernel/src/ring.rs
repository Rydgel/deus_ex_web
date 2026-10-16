//! Galaxy's ring voices (streamed, compressed or stereo samples, types
//! `& 0xe000` or `& 0x40`), translated from Galaxy.dll (GOTY, preferred base
//! 0x10600000): the 64 KB ring glxStartSample allocates (effects.rs, the
//! branch 0x106124e9..0x1061258f), the mixer's refill posts (sequencer.rs
//! `post_refills`, 0x106151bb..0x1061520c) and the stream decoder thread's
//! handler of message 0x400 (0x1060e363..0x1060e80d, the body of the thread
//! 0x1060e340). Contract: docs/audio-output-scope.md §2.3, §2.4 and
//! docs/galaxy-audio.md "Speech on Galaxy's ring transport". Verified against
//! the original under Unicorn (scripts/native-galaxy-ring-oracle.py,
//! scripts/validate-galaxy-ring-voice.mjs). Integer code only.
//!
//! Host choices, labelled:
//! - The decoder, the MPEG decoder 0x1061a690, is not ported (row 4.5.6, the
//!   user's decision of 2026-10-16). `decode_leaf` stands in for it: the
//!   record's source is the host's decoded 16-bit PCM (interleaved for a
//!   stereo record) instead of the MP3 bytes, and each call copies what fits
//!   (consumed = the source bytes copied, produced = the bytes written to each
//!   ring). The oracle replaces 0x1061a690 with the same leaf.
//! - Delivery: a posted message is handled after the timer callback that
//!   posted it, in post order. In the original the decoder thread (HIGHEST
//!   priority) takes it whenever the scheduler runs it, possibly during the
//!   rest of the callback on another core; the ring bytes it writes are
//!   behind the posted read head (or, at the first fill, at least 0x2000
//!   bytes ahead of it), which the rest of a callback does not reach.
//! - The voice mutexes: the decoder's WaitForMultipleObjects succeeds at once
//!   (the game thread holds a voice mutex only inside a library call, and a
//!   message is handled between calls).
//! - Address model: voice slot s's ring is at RING_POOL + s·RING_STRIDE (the
//!   original's malloc(0x1001f) result is only used as a pointer; a voice
//!   owns at most one ring, freed by glxStopSample before the next start).
use super::*;

/// Ring allocations by voice slot (see the address model above).
pub(crate) const RING_POOL: u32 = 0x6800_0000;
pub(crate) const RING_STRIDE: u32 = 0x10020;
/// malloc(0x1001f) at 0x106124e9; `rep stosd` zeroes the first 0x10000 bytes
/// (0x106124f9..0x10612502), so the last 0x1f bytes are never written (0 here).
pub(crate) const RING_ALLOC: usize = 0x1001f;
pub(crate) const RING_BYTES: u32 = 0x10000;

/// The decoder thread wrote through a Link to a voice that is no longer a
/// ring voice (a stereo pair's second slot restarted with a WAV while the
/// first still plays): the original writes the second channel, and zeroes, at
/// that voice's `+0x52` (another sample's data and the heap after it). The
/// writes are dropped here (mixer hazards, galaxy_mixer_hazards).
pub const HAZARD_RING_FOREIGN_WRITE: u32 = 8;
/// A refill found no source bytes for the record (the host released the PCM
/// of a record a ring voice still reads): the leaf answers nothing, as at the
/// end of a stream. Host timing only; the original's MP3 bytes never go.
pub const HAZARD_RING_NO_SOURCE: u32 = 16;

// Faults (paths not reachable with the shipped sounds; the original runs code
// not translated here).
pub const UNSUPPORTED_RING_DECODER: u32 = 0x150; // 0x1061a170 (IMA ADPCM, type 0x2000) or 0x10619800 (stereo PCM WAV)
pub const UNSUPPORTED_RING_REFILL: u32 = 0x151; // the type 0x8000 source refill through [0x1069838c] (GLX_LOADASSTREAMING)
pub const UNSUPPORTED_RING_ACCESS: u32 = 0x152; // a ring copy or a source read outside its allocation
pub const UNSUPPORTED_RING_FREE: u32 = 0x153; // free() of an address that is no ring
pub const RING_REPLAY_MISMATCH: u32 = 0x154; // a decoder call whose arguments differ from the capture's, or none left (galaxy_ring_record_*)

/// One MPEG decoder call of a capture of the running original (0x1061a690:
/// the source offset, Remaining and Chunk it was called with, the Consumed
/// and Produced it answered and the bytes it wrote at Dest1 and Dest2).
pub struct RecordedCall {
    pub src_off: u32,
    pub remaining: i32,
    pub chunk: i32,
    pub consumed: i32,
    pub produced: i32,
    pub bytes1: Vec<u8>,
    pub bytes2: Vec<u8>,
}

// Test-only translation mutants (validate-galaxy-ring-voice.mjs).
pub const MUTANT_NO_HEAD_START: u32 = 501; // the first fill at the read head (no + 0x2000)
pub const MUTANT_RING_LOOP_8000: u32 = 502; // the ring loop end at + 0x8000 instead of + 0x7fff
pub const MUTANT_NO_FILL_CAP: u32 = 503; // a message fills (read − write) mod 0x10000 without the 0x8000 cap
pub const MUTANT_END_ALWAYS: u32 = 504; // the end is set whatever the read head's place (no `read < write` test)
pub const MUTANT_ONE_ATTEMPT: u32 = 505; // a decoder answer of nothing ends the stream at once (no second attempt)

impl Library {
    /// The ring of voice slot `slot`: malloc(0x1001f), the first 0x10000 bytes zeroed.
    pub(crate) fn ring_alloc(&mut self, slot: usize) -> u32 {
        self.effects.rings[slot] = Some(vec![0; RING_ALLOC]);
        self.rebuild_regions();
        RING_POOL + slot as u32 * RING_STRIDE
    }

    /// free() of a ring (glxStopSample, 0x10618503..0x10618518).
    pub(crate) fn ring_free(&mut self, addr: u32) -> Result<(), u32> {
        let off = addr.wrapping_sub(RING_POOL);
        let slot = (off / RING_STRIDE) as usize;
        if off % RING_STRIDE != 0 || slot >= self.effects.rings.len() || self.effects.rings[slot].is_none() {
            return Err(UNSUPPORTED_RING_FREE);
        }
        self.effects.rings[slot] = None;
        self.rebuild_regions();
        Ok(())
    }

    /// The ring allocation holding [addr, addr + n): (slot, byte offset).
    fn ring_at(&self, addr: u32, n: u32) -> Result<(usize, usize), u32> {
        let off = addr.wrapping_sub(RING_POOL);
        let slot = (off / RING_STRIDE) as usize;
        let at = off % RING_STRIDE;
        if slot >= self.effects.rings.len() || self.effects.rings[slot].is_none() || at as u64 + n as u64 > RING_ALLOC as u64 {
            return Err(UNSUPPORTED_RING_ACCESS);
        }
        Ok((slot, at as usize))
    }

    /// `n` bytes at `addr` in a ring: written by `f`, or dropped with
    /// HAZARD_RING_FOREIGN_WRITE when they are not in one.
    fn ring_write(&mut self, addr: u32, n: u32, f: impl FnOnce(&mut [u8])) {
        if n == 0 {
            return;
        }
        match self.ring_at(addr, n) {
            Ok((slot, at)) => f(&mut self.effects.rings[slot].as_mut().unwrap()[at..at + n as usize]),
            Err(_) => self.player.mixer.hazards |= HAZARD_RING_FOREIGN_WRITE,
        }
    }

    fn ring_zero(&mut self, addr: u32, n: u32) {
        self.ring_write(addr, n, |b| b.fill(0));
    }

    /// The stand-in for the MPEG decoder 0x1061a690(Sample, Source, Remaining,
    /// Dest1, Dest2, Chunk, &Consumed, &Produced): the source is the host PCM
    /// (see the module comment). Mono: min(Chunk, Remaining) bytes to Dest1.
    /// Stereo (record type 0x40): min(Chunk / 2, Remaining / 4) frames, the
    /// left samples to Dest1 and the right ones to Dest2 (when not null).
    fn decode_leaf(&mut self, record: &[u8; 0x48], src: u32, remaining: i32, dst1: u32, dst2: u32, chunk: i32) -> Result<(i32, i32), u32> {
        if let Some(queue) = self.effects.recorded.as_mut() {
            // The replay of a capture: the original decoder's answer for this call.
            let call = queue.pop_front().ok_or(RING_REPLAY_MISMATCH)?;
            let off = src.wrapping_sub(get32(record, 0x44));
            if off != call.src_off || remaining != call.remaining || chunk != call.chunk {
                self.player.output.mismatch = [off, remaining as u32, chunk as u32, call.src_off, call.remaining as u32, call.chunk as u32];
                return Err(RING_REPLAY_MISMATCH);
            }
            let (b1, b2) = (call.bytes1, call.bytes2);
            self.ring_write(dst1, b1.len() as u32, |b| b.copy_from_slice(&b1));
            if dst2 != 0 {
                self.ring_write(dst2, b2.len() as u32, |b| b.copy_from_slice(&b2));
            }
            return Ok((call.consumed, call.produced));
        }
        let stereo = get16(record, 0x2c) & 0x40 != 0;
        let remaining = remaining.max(0) as u32;
        let chunk = chunk.max(0) as u32;
        let (consumed, produced) = if stereo {
            let frames = (chunk / 2).min(remaining / 4);
            (4 * frames, 2 * frames)
        } else {
            let n = chunk.min(remaining) & !1;
            (n, n)
        };
        if produced == 0 {
            return Ok((0, 0));
        }
        let data = get32(record, 0x44);
        let Some(sample) = self.effects.samples.iter().find(|s| s.data_addr == data && s.data_addr != 0) else {
            self.player.mixer.hazards |= HAZARD_RING_NO_SOURCE;
            return Ok((0, 0));
        };
        let from = src.wrapping_sub(data) as usize;
        if from + consumed as usize > sample.data.len() {
            return Err(UNSUPPORTED_RING_ACCESS);
        }
        let source = sample.data[from..from + consumed as usize].to_vec();
        if !stereo {
            self.ring_write(dst1, produced, |b| b.copy_from_slice(&source));
        } else {
            for (dst, lane) in [(dst1, 0usize), (dst2, 2)] {
                if dst == 0 {
                    continue;
                }
                self.ring_write(dst, produced, |b| {
                    for f in 0..(produced / 2) as usize {
                        b[2 * f] = source[4 * f + lane];
                        b[2 * f + 1] = source[4 * f + lane + 1];
                    }
                });
            }
        }
        Ok((consumed as i32, produced as i32))
    }

    /// The decoder thread's handler of PostThreadMessageA(thread, 0x400,
    /// wParam = voice index, lParam = the read head in samples or bytes,
    /// `V+0x46 − V+0x52`), 0x1060e363..0x1060e80d.
    pub fn decoder_message(&mut self, wparam: u32, lparam: u32) -> Result<(), u32> {
        let v = wparam as usize;
        if v >= VOICES {
            return Err(crate::effects::UNSUPPORTED_VOICE);
        }
        let kind = self.vw(v, 0x4c);
        if kind & 0xe000 == 0 && kind & 0x40 == 0 {
            return Ok(()); // 0x1060e37b..0x1060e38a
        }
        // 0x1060e396..0x1060e3cf: WaitForMultipleObjects over the Link chain's
        // mutexes; with none it fails (n = 0 is invalid) and the message is dropped.
        let mut waits = 0;
        let mut cur = crate::effects::VOICE_BASE + v as u32 * VOICE as u32;
        while cur != 0 && waits <= VOICES {
            let s = self.voice_slot(cur)?;
            if self.vd(s, 0x98) == 0 {
                break;
            }
            waits += 1;
            cur = self.vd(s, 0x9c);
        }
        if waits == 0 || self.vd(v, 0x98) == 0 {
            return Ok(());
        }
        let link = self.vd(v, 0x9c);
        let l = if link != 0 { Some(self.voice_slot(link)?) } else { None };
        if let Some(l) = l {
            if self.vd(l, 0x98) == 0 {
                return Ok(()); // 0x1060e40e: ReleaseMutex(V+0x98) only
            }
        }
        let wide = kind & 4 != 0;
        let read = if wide { lparam.wrapping_add(lparam) } else { lparam };
        let mut write = self.vd(v, 0x88);
        let mut offset = self.vd(v, 0x8c);
        // 0x1060e43f..0x1060e47b: the source length times 1 for a decoded type, else channels · bytes per sample.
        let factor = if kind & 0x6000 != 0 { 1 } else { (if kind & 0x40 != 0 { 2 } else { 1 }) * (if wide { 2 } else { 1 }) };
        let record = self.sample_record(self.vd(v, 0x42))?;
        let mut total = get32(&record, 0x30).wrapping_mul(factor);
        let source = get32(&record, 0x44);
        let ring = if wide { self.vd(v, 0x52) << 1 } else { self.vd(v, 0x52) };
        let link_ring = match l {
            Some(l) if self.vb(l, 0x4c) & 4 != 0 => self.vd(l, 0x52) << 1,
            Some(l) => self.vd(l, 0x52),
            None => 0,
        };
        // 0x1060e4bd..0x1060e4d7: the start sentinel; the first fill lands 0x2000 bytes past the read head.
        if write == 0x10000 {
            let lead = if self.mutant(MUTANT_NO_HEAD_START) { 0 } else { 0x2000 };
            write = read.wrapping_add(lead) & 0xffff;
        }
        let mut n = read.wrapping_sub(write) as i32;
        if n < 0 {
            n = n.wrapping_add(0x10000);
        }
        if n >= 0x8000 && !self.mutant(MUTANT_NO_FILL_CAP) {
            n = 0x8000;
        }
        if kind & 0x8000 != 0 {
            total = self.vd(v, 0x94);
            offset = self.vd(v, 0x90);
        }
        let mut attempt = 0;
        while n != 0 {
            let room = 0x10000 - write as i32;
            let chunk = if n < room { n } else { room };
            let dst2 = if l.is_some() { link_ring.wrapping_add(write) } else { 0 };
            let dst1 = ring.wrapping_add(write);
            let record = self.sample_record(self.vd(v, 0x42))?;
            let src = source.wrapping_add(offset);
            let remaining = total.wrapping_sub(offset) as i32;
            let rtype = get16(&record, 0x2c);
            let (mut consumed, produced) = if rtype & 0x4000 != 0 {
                self.decode_leaf(&record, src, remaining, dst1, dst2, chunk)?
            } else {
                return Err(UNSUPPORTED_RING_DECODER);
            };
            if consumed > remaining {
                consumed = remaining; // 0x1060e5a8..0x1060e5ac
            }
            if consumed != 0 || produced != 0 {
                // 0x1060e6cd..0x1060e6f1
                write = write.wrapping_add(produced as u32) & 0xffff;
                attempt = 0;
                n = n.wrapping_sub(produced);
                offset = offset.wrapping_add(consumed as u32);
                continue;
            }
            if self.vb(v, 0x4d) & 0x80 != 0 && offset != 0 {
                return Err(UNSUPPORTED_RING_REFILL); // 0x1060e5f2..0x1060e652
            }
            attempt += 1;
            if attempt >= 2 || self.mutant(MUTANT_ONE_ATTEMPT) {
                break;
            }
        }
        // 0x1060e672..0x1060e691
        let kind_now = self.vw(v, 0x4c);
        if kind_now & 0x8000 != 0 {
            self.sd(v, 0x90, offset);
            self.sd(v, 0x94, total);
            offset = offset.wrapping_add(self.vd(v, 0x8c));
        }
        if n != 0 {
            let record = self.sample_record(self.vd(v, 0x42))?;
            if get16(&record, 0x2c) & 8 != 0 {
                offset = get32(&record, 0x34); // 0x1060e7d8: a looped sample starts its source again
            } else {
                // 0x1060e6b0..0x1060e7d6: the end of the stream. When the read
                // head is below the write position, the voice stops looping and
                // ends there; the rest of the ring is zeroed.
                let below = (read as i32) < (write as i32) || self.mutant(MUTANT_END_ALWAYS);
                let span = n as u32;
                for (s, base) in [(Some(v), ring), (l, link_ring)] {
                    let Some(s) = s else { continue };
                    if below {
                        let k = self.vw(s, 0x4c) & 0xff77;
                        self.sw(s, 0x4c, k);
                        let end = if k & 4 != 0 { base.wrapping_add(write) >> 1 } else { base.wrapping_add(write) };
                        self.sd(s, 0x56, end);
                        self.sd(s, 0x5a, end);
                    }
                    let room = 0x10000 - write;
                    if room < span {
                        self.ring_zero(base.wrapping_add(write), room);
                        self.ring_zero(base, span + write - 0x10000);
                    } else {
                        self.ring_zero(base.wrapping_add(write), span);
                    }
                }
                write = span.wrapping_add(write) & 0xffff;
            }
        }
        self.sd(v, 0x88, write);
        self.sd(v, 0x8c, offset);
        // ReleaseMutex(L+0x98), ReleaseMutex(V+0x98): no effect in the model.
        Ok(())
    }

    /// Every posted refill message, in post order (the delivery model above).
    pub fn deliver_refills(&mut self) -> Result<u32, u32> {
        let mut handled = 0;
        while let Some((wparam, lparam)) = self.effects.posts.pop_front() {
            self.decoder_message(wparam, lparam)?;
            handled += 1;
        }
        Ok(handled)
    }
}

// ---- Wasm exports -------------------------------------------------------------

fn with_library<R>(f: impl FnOnce(&mut Library) -> R) -> R {
    LIBRARY.with(|l| f(&mut l.borrow_mut()))
}

/// Handles every pending refill message; the count, or 0 with galaxy_fault set.
#[no_mangle]
pub extern "C" fn galaxy_ring_deliver() -> u32 {
    with_library(|l| {
        if l.player.fault != 0 {
            return 0;
        }
        match l.deliver_refills() {
            Ok(n) => n,
            Err(e) => {
                l.player.fault = e;
                0
            }
        }
    })
}

/// Validator: the pending refill messages' count.
#[no_mangle]
pub extern "C" fn galaxy_ring_posts() -> u32 {
    with_library(|l| l.effects.posts.len() as u32)
}

/// Validator: the next pending message's wParam (`part` 0) or lParam (1).
#[no_mangle]
pub extern "C" fn galaxy_ring_next(part: u32) -> u32 {
    with_library(|l| l.effects.posts.front().map_or(0xffff_ffff, |&(w, p)| if part == 0 { w } else { p }))
}

/// Validator: handles the next pending message; 1, or 0 when none or on a fault.
#[no_mangle]
pub extern "C" fn galaxy_ring_deliver_one() -> u32 {
    with_library(|l| {
        if l.player.fault != 0 {
            return 0;
        }
        let Some((w, p)) = l.effects.posts.pop_front() else { return 0 };
        match l.decoder_message(w, p) {
            Ok(()) => 1,
            Err(e) => {
                l.player.fault = e;
                0
            }
        }
    })
}

/// Replay: start (1) or stop (0) answering the decoder from a capture's calls.
#[no_mangle]
pub extern "C" fn galaxy_ring_record_mode(enable: u32) {
    with_library(|l| l.effects.recorded = if enable != 0 { Some(std::collections::VecDeque::new()) } else { None });
}

/// Replay: one captured decoder call; galaxy_input holds its Dest1 bytes (`n1`) then its Dest2 bytes.
#[no_mangle]
pub extern "C" fn galaxy_ring_record_push(src_off: u32, remaining: i32, chunk: i32, consumed: i32, produced: i32, n1: u32, len: u32) {
    let bytes = INPUT.with(|i| {
        let mut input = i.borrow_mut();
        let n = (len as usize).min(input.len());
        let b = input[..n].to_vec();
        *input = Vec::new();
        b
    });
    let n1 = (n1 as usize).min(bytes.len());
    with_library(|l| {
        if let Some(q) = l.effects.recorded.as_mut() {
            q.push_back(RecordedCall { src_off, remaining, chunk, consumed, produced, bytes1: bytes[..n1].to_vec(), bytes2: bytes[n1..].to_vec() });
        }
    });
}

/// Replay: the captured decoder calls not yet taken.
#[no_mangle]
pub extern "C" fn galaxy_ring_record_left() -> u32 {
    with_library(|l| l.effects.recorded.as_ref().map_or(0, |q| q.len() as u32))
}

/// Replay: the last mismatch (the call's source offset, Remaining, Chunk, then the capture's).
#[no_mangle]
pub extern "C" fn galaxy_ring_mismatch(index: u32) -> u32 {
    with_library(|l| l.player.output.mismatch.get(index as usize).copied().unwrap_or(0))
}

/// The ring of voice slot `slot` (RING_ALLOC bytes), or null.
#[no_mangle]
pub extern "C" fn galaxy_ring_bytes(slot: u32) -> *const u8 {
    with_library(|l| {
        l.effects.rings.get(slot as usize).and_then(|r| r.as_ref()).map_or(std::ptr::null(), |r| r.as_ptr())
    })
}
