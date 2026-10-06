//! Galaxy's effects reverb (glxSetSampleReverb 0x106113d0, its SSE setup
//! 0x106109f0 and kernel 0x10622d33): not yet translated; the hook stays
//! unset, as for a listener outside every reverb zone.
use super::*;

impl Library {
    /// The effects reverb hook [0x10688288](ctx [0x10688284], d04, d0c, k, 0).
    pub(crate) fn reverb_hook(&mut self, _k: i32) -> Result<(), u32> {
        Ok(())
    }
}
