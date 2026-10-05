//! The browser host's entries into the library (docs/galaxy-music.md,
//! "Phase 5: Output"). The AudioWorklet (src/viewer/galaxy-music-worklet.js)
//! owns the one library instance and applies the simulation's batches here,
//! one library call per op, between two timer callbacks. Each export is a
//! thin call of the translated entry it names; none adds behaviour.
//!
//! Host decisions, not the original's (documented in docs/galaxy-music.md):
//! the output open runs once at the worklet's start with a pinned ring fill
//! `ahead` (0x10697cdc), and the load path skips the loader dump the
//! validators read.
use super::*;

fn library<R>(f: impl FnOnce(&mut Library) -> R) -> R {
    LIBRARY.with(|l| f(&mut l.borrow_mut()))
}

/// glxInit's state, the subsystem Init's 0x1060ebc0(EffectsChannels), then
/// the output open as DX runs it on the reference machine (44100 Hz, 16-bit
/// stereo, flags 7, MMX and SSE; `pc` = the x87 precision bits the pan table
/// is built under), and the ring fill the timer callbacks start from.
#[no_mangle]
pub extern "C" fn galaxy_host_open(effects_channels: u32, pc: u32, ahead: u32) -> u32 {
    galaxy_reset(effects_channels);
    library(|l| {
        let status = l.setup_output(pc, [1, 1, 0], 44100, 2, 16, 7);
        l.player.ahead_pin = ahead;
        status
    })
}

/// glxLoadMusic(&Mem{Data, len + 1024}, GLX_LOADFROMMEMORY) on the input
/// buffer (galaxy_input(len), filled with the module and the caller's
/// 1024-byte slack). The input and the loader logs are released after.
#[no_mangle]
pub extern "C" fn galaxy_music_load(len: u32) -> u32 {
    INPUT.with(|i| {
        let mut input = i.borrow_mut();
        let status = library(|l| {
            let status = l.load_music(&input, len);
            l.alloc_log = Vec::new();
            l.stream_log = Vec::new();
            status
        });
        *input = Vec::new();
        status
    })
}

/// glxUnloadMusic 0x10619450.
#[no_mangle]
pub extern "C" fn galaxy_music_unload() -> u32 {
    library(|l| l.unload_music())
}

/// glxStopMusic 0x106183a0.
#[no_mangle]
pub extern "C" fn galaxy_music_stop() -> u32 {
    library(|l| l.stop_music())
}

/// glxStartMusic 0x106122a0.
#[no_mangle]
pub extern "C" fn galaxy_music_start() -> u32 {
    library(|l| l.start_music())
}

/// glxControlMusic 0x1060d0e0.
#[no_mangle]
pub extern "C" fn galaxy_music_control(cmd: i32, arg: i32) -> u32 {
    library(|l| l.control_music(cmd, arg))
}

/// Update's direct store into the voice table (0x1060a82a..0x1060a844):
/// voice +0x0f = 0 for `count` voices from `first` (the subsystem's +0x64,
/// EffectsChannels). With EffectsChannels clamped to 0..32 by Init the range
/// ends inside the 256-voice table; a voice past it is not written.
#[no_mangle]
pub extern "C" fn galaxy_music_clear_active(first: u32, count: u32) {
    library(|l| {
        for v in first..first.saturating_add(count) {
            if (v as usize) < VOICES {
                l.voices[v as usize * VOICE + 0xf] = 0;
            }
        }
    })
}

/// Update's `byte [0x10697ca8] = 1` (0x1060a88d), the pending position jump.
#[no_mangle]
pub extern "C" fn galaxy_music_break() {
    library(|l| l.break_flag = 1)
}

/// Byte [0x10698201], the order position Update copies into SongSection.
#[no_mangle]
pub extern "C" fn galaxy_music_order() -> u32 {
    library(|l| l.order_position as u32)
}

/// The library state the host's order mirror starts from: order position
/// (bits 0..7), playing [0x10698349] (bit 8), song length [0x1069834a]
/// (bits 16..23), a module loaded ([0x10698348] != 0, bit 24).
#[no_mangle]
pub extern "C" fn galaxy_music_state() -> u32 {
    library(|l| {
        l.order_position as u32
            | ((l.playing != 0) as u32) << 8
            | (l.song_length as u32) << 16
            | ((l.channels != 0) as u32) << 24
    })
}

/// glxSetMusicVolume 0x1060eb60.
#[no_mangle]
pub extern "C" fn galaxy_set_music_volume(volume: i32, mode: i32) -> u32 {
    library(|l| l.set_music_volume(volume, mode))
}

/// glxSetSampleVolume 0x1060ec00.
#[no_mangle]
pub extern "C" fn galaxy_set_sample_volume(volume: i32, mode: i32) -> u32 {
    library(|l| l.set_sample_volume(volume, mode))
}

// TEMPORARY: replaced by the mixer agent's galaxy_render
//
// Stand-in with the mixer agent's export names and contract: one renderer
// request of `frames` frames (the timer callback's mixer calls of n =
// remaining frames, each at most 512, from the pinned ring fill), returning
// interleaved stereo int16 of bus A, or 0 on a fault (galaxy_fault gives the
// code). The sequencer, voice update and per-voice hand-off run for real; the
// inner kernel is still sequencer.rs's recorded stub, so the PCM is silence.
thread_local! {
    static TEMPORARY_PCM: RefCell<Vec<i16>> = const { RefCell::new(Vec::new()) };
}

#[no_mangle]
pub extern "C" fn galaxy_render(frames: u32) -> *const i16 {
    let ok = library(|l| {
        if l.player.fault != 0 {
            return false;
        }
        l.player.ahead = l.player.ahead_pin;
        let mut remaining = frames as i32;
        while remaining > 0 {
            match l.mix(remaining) {
                Ok(k) if k > 0 => remaining -= k,
                Ok(_) => {
                    l.player.fault = sequencer::UNSUPPORTED_SPIN;
                    return false;
                }
                Err(e) => {
                    l.player.fault = e;
                    return false;
                }
            }
        }
        true
    });
    if !ok {
        return std::ptr::null();
    }
    TEMPORARY_PCM.with(|p| {
        let mut pcm = p.borrow_mut();
        pcm.clear();
        pcm.resize(frames as usize * 2, 0);
        pcm.as_ptr()
    })
}

#[no_mangle]
pub extern "C" fn galaxy_fault() -> u32 {
    library(|l| l.player.fault)
}
// END TEMPORARY
