//! URender::OccludeBsp, the original BSP span occlusion (docs/bsp-occlusion.md).
//!
//! Render.dll SHA-256 607f1077…5d1; addresses below are its instructions.
//! The pass runs between URender::PreRender and PostRender, under
//! appEnableFastMath(1) (0x10b14629: `_controlfp(_PC_24, _MCW_PC)`), so each
//! x87 arithmetic result is rounded to a 24-bit significand. For the
//! normal-range values of world geometry that is exactly IEEE binary32
//! arithmetic: the port computes in f32 in the original's operation order
//! (Rust never fuses or reassociates). Integer conversions follow FISTP with
//! round-to-nearest-even (`_ftol` truncation of the clamped bound floats in
//! the zone box test is the identity on those integers).
//!
//! The host uploads the map's compiled model once (FBspNode records in their
//! original 64-byte layout, whose NodeFlags byte is live state here as in the
//! original, FVert, FVector points, surface and texture PolyFlags, render
//! bounds, zone actors) and calls `occ_run` per frame with the frame fields
//! ComputeRenderSize produced. A work block holds the original's memory
//! stacks as word arenas; every structure the original allocates there is a
//! word record, linked by word indices (0 = NULL).
//!
//! Not covered yet (explicit): dynamics (SetupDynamics sprites and chunks,
//! FDynamicLight), LeafVolumetricLighting and volumetric side planes, the
//! moving-brush tracker (Level+0xfc), the sky and mirror child frames' own
//! occlusion (requests are reported), WarpZoneInfo portals (none in the
//! single-player maps), span-based render devices.

use core::ptr::{addr_of, addr_of_mut};

// ---- host interface --------------------------------------------------------

/// Model words: 0 nodes, 1 node count, 2 verts, 3 vert count, 4 points,
/// 5 point count, 6 surfs (2 words: PolyFlags, texture PolyFlags), 7 surf
/// count, 8 bounds (7 words: FBox), 9 bound count, 10 zones (4 words: zone
/// actor key, LastRenderTime bits, its SkyZone (+1, 0 = none), 0), 11 zone count (Model.NumZones), 12
/// RootOutside, 13 point cache (2 words per point: FTransform, stamp), 14
/// Stamp, 15 LevelInfo key, 16 the dynamics table (3 words per node: pending
/// chunks, front and back final chunks), 17 the frame's sprites (6 words
/// each: key, X1, Y1, X2, Y2, Z bits, in SetupDynamics order), 18 their
/// count. Addresses are byte addresses in this memory.
static mut MODEL: [u32; 20] = [0; 20];
/// Frame words (FSceneNode fields, f32 bits unless noted): 0..12 Coords,
/// 12 X (int), 13 Y (int), 14 FX15, 15 FY15, 16 FX2, 17 FY2, 18 FX, 19 FY,
/// 20 Proj.Z, 21 PrjXM, 22 PrjYM, 23 PrjXP, 24 PrjYP, 25..37 ViewSides,
/// 37..41 NearClip, 41 Mirror, 42 ZoneNumber, 43 Recursion, 44 the frame
/// counter (0x10b5a700), 45 Level.TimeSeconds, 46 option bits (1 viewer
/// ShowFlags & 0x800, 2 RenDev ShinySurfaces, 4 URender Toggle; 0x100 asks
/// the output to carry each saved polygon's points), 47
/// Viewport ExtraPolyFlags, 48..60 Uncoords, 60 RProj.Z.
static mut FRAME: [u32; 64] = [0; 64];
/// Run results: 0 status, 1 output words, 2 NodesDraw (+0x68), 3 PolysDraw
/// (+0x6c), 4 child requests, 5 the output's address.
static mut STATUS: [u32; 8] = [0; 8];

#[no_mangle]
pub extern "C" fn occ_model_ptr() -> *mut u32 {
    addr_of_mut!(MODEL) as *mut u32
}
#[no_mangle]
pub extern "C" fn occ_frame_ptr() -> *mut u32 {
    addr_of_mut!(FRAME) as *mut u32
}
#[no_mangle]
pub extern "C" fn occ_status_ptr() -> *const u32 {
    addr_of!(STATUS) as *const u32
}

// ---- raw memory --------------------------------------------------------------

#[inline(always)]
fn rd(address: u32) -> u32 {
    unsafe { core::ptr::read(address as *const u32) }
}
#[inline(always)]
fn wr(address: u32, value: u32) {
    unsafe { core::ptr::write(address as *mut u32, value) }
}
#[inline(always)]
fn rd8(address: u32) -> u8 {
    unsafe { core::ptr::read(address as *const u8) }
}
#[inline(always)]
fn wr8(address: u32, value: u8) {
    unsafe { core::ptr::write(address as *mut u8, value) }
}
#[inline(always)]
fn rf(address: u32) -> f32 {
    f32::from_bits(rd(address))
}
fn model(i: usize) -> u32 {
    unsafe { (*addr_of!(MODEL))[i] }
}
fn frame(i: usize) -> u32 {
    unsafe { (*addr_of!(FRAME))[i] }
}
fn ff(i: usize) -> f32 {
    f32::from_bits(frame(i))
}

/// FISTP under round-to-nearest: ties to even; NaN or out of int32 range
/// stores the integer indefinite.
fn fistp(x: f32) -> i32 {
    if !(x >= -2147483648.0 && x < 2147483648.0) {
        return i32::MIN;
    }
    let a = if x < 0.0 { -x } else { x };
    if a >= 8388608.0 {
        return x as i32;
    }
    // Adding and removing 2^23 rounds to an integer, ties to even.
    let r = (a + 8388608.0) - 8388608.0;
    (if x < 0.0 { -r } else { r }) as i32
}
/// The float32 sign bit, as the outcode tables and clip tests read it.
#[inline(always)]
fn sb(x: f32) -> bool {
    x.to_bits() >> 31 != 0
}

// ---- model ---------------------------------------------------------------------

struct Node(u32);
impl Node {
    fn at(i: i32) -> Node {
        Node(model(0) + 64 * i as u32)
    }
    fn plane(&self, k: u32) -> f32 {
        rf(self.0 + 4 * k)
    }
    fn zone_mask(&self) -> u64 {
        rd(self.0 + 16) as u64 | (rd(self.0 + 20) as u64) << 32
    }
    fn vert_pool(&self) -> u32 {
        rd(self.0 + 24)
    }
    fn surf(&self) -> i32 {
        rd(self.0 + 28) as i32
    }
    fn child(&self, k: u32) -> i32 {
        rd(self.0 + 32 + 4 * k) as i32
    }
    fn coplanar(&self) -> i32 {
        rd(self.0 + 40) as i32
    }
    fn render_bound(&self) -> i32 {
        rd(self.0 + 48) as i32
    }
    fn zone(&self, k: u32) -> u8 {
        rd8(self.0 + 52 + k)
    }
    fn num_vertices(&self) -> u8 {
        rd8(self.0 + 54)
    }
    fn flags(&self) -> u8 {
        rd8(self.0 + 55)
    }
    fn set_flags(&self, v: u8) {
        wr8(self.0 + 55, v)
    }
    fn is_csg(&self) -> bool {
        self.num_vertices() > 0 && self.flags() & 0x21 == 0
    }
    /// FBspNode::ChildOutside.
    fn child_outside(&self, child: u32, outside: bool) -> bool {
        if child != 0 {
            outside || self.is_csg()
        } else {
            outside && !self.is_csg()
        }
    }
    /// ((O.z*P.z + O.y*P.y) + O.x*P.x) - P.w, the order of 0x10b17c42.
    fn distance(&self, o: [f32; 3]) -> f32 {
        ((o[2] * self.plane(2) + o[1] * self.plane(1)) + o[0] * self.plane(0)) - self.plane(3)
    }
}

// ---- work block: the original's memory stacks ------------------------------------

const GMEM: usize = 0;
const GDYN: usize = 1;
const GSCENE: usize = 2;
const VECTOR: usize = 3;
const OUT: usize = 4;

/// Word arenas in the host's work block: base, top, limit (byte addresses).
static mut ARENA: [[u32; 3]; 5] = [[0; 3]; 5];
static mut OVERFLOW: bool = false;

fn arena_top(a: usize) -> u32 {
    unsafe { (*addr_of!(ARENA))[a][1] }
}
fn set_top(a: usize, top: u32) {
    unsafe { (*addr_of_mut!(ARENA))[a][1] = top }
}
/// FMemStack bump with the original's alignment; the address is never read
/// back as data, so any placement gives the same results.
fn push(a: usize, bytes: u32, align: u32) -> u32 {
    unsafe {
        let arena = &mut (*addr_of_mut!(ARENA))[a];
        let at = (arena[1] + align - 1) & !(align - 1);
        if at + bytes > arena[2] {
            *addr_of_mut!(OVERFLOW) = true;
            // Keep running on the arena's start; the run reports failure.
            arena[1] = arena[0];
            return arena[0];
        }
        arena[1] = at + bytes;
        at
    }
}

// ---- FSpanBuffer (0x10b21730..0x10b22459; .work/occlude/span-buffer.md) --------------

/// FSpan: Start, End, Next (12 bytes). Index entries are span addresses.
#[derive(Clone, Copy)]
struct SpanBuffer {
    start_y: i32,
    end_y: i32,
    valid: i32,
    index: u32,
    mem: usize,
    mark_mem: usize,
    mark_top: u32,
}
const EMPTY: SpanBuffer = SpanBuffer { start_y: 0, end_y: 0, valid: 0, index: 0, mem: 0, mark_mem: 0, mark_top: 0 };

fn new_span(mem: usize, start: i32, end: i32) -> u32 {
    let s = push(mem, 12, 4);
    wr(s, start as u32);
    wr(s + 4, end as u32);
    s
}
fn s_start(s: u32) -> i32 {
    rd(s) as i32
}
fn s_end(s: u32) -> i32 {
    rd(s + 4) as i32
}
fn s_next(s: u32) -> u32 {
    rd(s + 8)
}

impl SpanBuffer {
    fn line(&self, y: i32) -> u32 {
        self.index + 4 * (y - self.start_y) as u32
    }
    /// AllocIndex 0x10b21730: the index is not initialized; the mark follows it.
    fn alloc_index(&mut self, start_y: i32, end_y: i32, mem: usize) {
        self.mem = mem;
        self.start_y = start_y;
        self.end_y = end_y;
        self.valid = 0;
        self.index = if start_y > end_y { 0 } else { push(mem, 4 * (end_y - start_y) as u32, 8) };
        self.mark_mem = mem;
        self.mark_top = arena_top(mem);
    }
    /// AllocIndexForScreen 0x10b21810 (the mark is not set).
    fn alloc_index_for_screen(&mut self, sxr: i32, syr: i32, mem: usize) {
        self.mem = mem;
        self.start_y = 0;
        self.valid = syr;
        self.end_y = syr;
        self.index = push(mem, 4 * syr as u32, 8);
        let list = push(mem, 12 * syr as u32, 8);
        for i in 0..syr.max(0) as u32 {
            let s = list + 12 * i;
            wr(self.index + 4 * i, s);
            wr(s, 0);
            wr(s + 4, sxr as u32);
            wr(s + 8, 0);
        }
    }
    /// Release 0x10b21920: Mark.Pop().
    fn release(&self) {
        set_top(self.mark_mem, self.mark_top);
    }
    /// BoxIsVisible 0x10b21a20.
    fn box_is_visible(&self, x1: i32, mut y1: i32, x2: i32, mut y2: i32) -> bool {
        if y1 >= self.end_y || y2 <= self.start_y {
            return false;
        }
        if y1 < self.start_y {
            y1 = self.start_y;
        }
        if y2 > self.end_y {
            y2 = self.end_y;
        }
        let mut y = y1;
        while y < y2 {
            let mut s = rd(self.line(y));
            while s != 0 {
                if x2 <= s_start(s) {
                    break;
                }
                if x1 < s_end(s) {
                    return true;
                }
                s = s_next(s);
            }
            y += 1;
        }
        false
    }
    /// CopyFromRasterUpdate 0x10b21a90 (`update`) and CopyFromRaster
    /// 0x10b21df0: this = the raster's still-free part of `screen`; update
    /// also removes it from `screen`.
    /// `lines`: 0 for the polygon raster (lines by absolute Y), else an
    /// FRasterPoly record (StartY, EndY, lines from StartY).
    fn copy_from_raster(&mut self, screen: &mut SpanBuffer, raster_start: i32, raster_end: i32, update: bool, lines: u32) -> bool {
        if update && (self.start_y > raster_start || self.end_y < raster_end) {
            // "Illegal span range" warning; the index is left as allocated.
            return false;
        }
        let mut accept = false;
        let new_start = if raster_start < screen.start_y { screen.start_y } else { raster_start };
        let new_end = if raster_end > screen.end_y { screen.end_y } else { raster_end };
        let mut dest = self.index;
        if new_start >= new_end {
            for _ in self.start_y..self.end_y {
                wr(dest, 0);
                dest += 4;
            }
            return false;
        }
        for _ in self.start_y..new_start {
            wr(dest, 0);
            dest += 4;
        }
        let mut screen_index = screen.line(new_start);
        for y in new_start..new_end {
            let (x0, x1) = if lines == 0 { raster(y) } else { poly_line(lines, y) };
            let mut prev = dest;
            dest += 4;
            let mut s_link = screen_index;
            let mut s = rd(screen_index);
            screen_index += 4;
            'line: {
                if s == 0 || x1 <= x0 {
                    break 'line;
                }
                while s_end(s) <= x0 {
                    s_link = s + 8;
                    s = s_next(s);
                    if s == 0 {
                        break 'line;
                    }
                }
                if s_start(s) < x0 {
                    accept = true;
                    let n = new_span(self.mem, x0, if x1 > s_end(s) { s_end(s) } else { x1 });
                    wr(prev, n);
                    self.valid += 1;
                    prev = n + 8;
                    if update {
                        if s_end(s) > x1 {
                            let r = new_span(screen.mem, x1, s_end(s));
                            wr(r + 8, s_next(s));
                            wr(s + 8, r);
                            wr(s + 4, x0 as u32);
                            screen.valid += 1;
                            break 'line;
                        }
                        s_link = s + 8;
                        wr(s + 4, x0 as u32);
                    }
                    s = s_next(s);
                    if s == 0 {
                        break 'line;
                    }
                }
                while s_end(s) <= x1 {
                    accept = true;
                    let n = new_span(self.mem, s_start(s), s_end(s));
                    wr(prev, n);
                    self.valid += 1;
                    prev = n + 8;
                    if update {
                        wr(s_link, s_next(s));
                        screen.valid -= 1;
                    }
                    s = s_next(s);
                    if s == 0 {
                        break 'line;
                    }
                }
                if s_start(s) < x1 {
                    accept = true;
                    let n = new_span(self.mem, s_start(s), x1);
                    wr(prev, n);
                    prev = n + 8;
                    self.valid += 1;
                    if update {
                        wr(s, x1 as u32);
                    }
                }
            }
            wr(prev, 0);
        }
        for _ in new_end..self.end_y {
            wr(dest, 0);
            dest += 4;
        }
        accept
    }
    /// MergeWith 0x10b22090: this |= other.
    fn merge_with(&mut self, other: &SpanBuffer) {
        if self.start_y > other.start_y || other.end_y > self.end_y {
            let new_start = if self.start_y < other.start_y { self.start_y } else { other.start_y };
            let new_end = if self.end_y < other.end_y { other.end_y } else { self.end_y };
            let index = push(self.mem, 4 * (new_end - new_start) as u32, 8);
            let mut at = index;
            for _ in new_start..self.start_y {
                wr(at, 0);
                at += 4;
            }
            for y in self.start_y..self.end_y {
                wr(at, rd(self.line(y)));
                at += 4;
            }
            for _ in self.end_y..new_end {
                wr(at, 0);
                at += 4;
            }
            self.end_y = new_end;
            self.start_y = new_start;
            self.index = index;
        }
        let mut ti = self.line(other.start_y);
        let mut oi = other.index;
        for _ in other.start_y..other.end_y {
            let mut t = rd(ti);
            let mut o = rd(oi);
            let mut prev = ti;
            ti += 4;
            oi += 4;
            'line: loop {
                if t == 0 {
                    while o != 0 {
                        let n = new_span(self.mem, s_start(o), s_end(o));
                        wr(prev, n);
                        o = s_next(o);
                        prev = n + 8;
                        self.valid += 1;
                    }
                    break 'line;
                }
                if o == 0 {
                    break 'line;
                }
                if s_end(o) < s_start(t) {
                    let n = new_span(self.mem, s_start(o), s_end(o));
                    wr(prev, n);
                    o = s_next(o);
                    prev = n + 8;
                    wr(n + 8, t);
                    self.valid += 1;
                    continue;
                }
                if s_start(o) > s_end(t) {
                    wr(prev, t);
                    prev = t + 8;
                    t = s_next(t);
                    continue;
                }
                wr(prev, t);
                if s_start(t) > s_start(o) {
                    wr(t, s_start(o) as u32);
                }
                if s_end(t) < s_end(o) {
                    wr(t + 4, s_end(o) as u32);
                }
                let sp = t;
                prev = t + 8;
                t = s_next(t);
                loop {
                    o = s_next(o);
                    while t != 0 && s_start(t) <= s_end(sp) {
                        if s_end(t) >= s_end(sp) {
                            wr(sp + 4, s_end(t) as u32);
                        }
                        t = s_next(t);
                        self.valid -= 1;
                    }
                    if o != 0 && s_start(o) <= s_end(sp) {
                        if s_end(sp) < s_end(o) {
                            wr(sp + 4, s_end(o) as u32);
                        }
                        continue;
                    }
                    break;
                }
            }
            wr(prev, t);
        }
    }
    /// The per-line copy at 0x10b192a6..0x10b19361 (drawn portals): a GDynMem
    /// index and spans with this buffer's lines; ValidLines and the mark as
    /// this buffer's.
    fn copy_lines(&self, mem: usize) -> SpanBuffer {
        let mut copy = *self;
        copy.index = push(mem, 4 * (self.end_y - self.start_y) as u32, 8);
        copy.mem = mem;
        copy.mark_mem = mem;
        copy.mark_top = arena_top(mem);
        for i in 0..(self.end_y - self.start_y).max(0) as u32 {
            let mut link = copy.index + 4 * i;
            let mut s = rd(self.index + 4 * i);
            while s != 0 {
                let n = new_span(mem, s_start(s), s_end(s));
                wr(link, n);
                link = n + 8;
                s = s_next(s);
            }
            wr(link, 0);
        }
        copy
    }
}

// ---- raster (0x10b19cc0; globals 0x10b5a670 StartY, 0x10b50bec EndY,
// 0x10b5a674 MinX, 0x10b50be8 MaxX, lines at 0x10b50c08) ------------------------------

const RASTER_LINES: usize = 2880; // 0x10b50c08..0x10b56608
static mut RASTER: [[i32; 2]; RASTER_LINES] = [[0; 2]; RASTER_LINES];
static mut RASTER_BOX: [i32; 4] = [0; 4]; // StartY, EndY, MinX, MaxX

fn raster(y: i32) -> (i32, i32) {
    unsafe {
        let line = (*addr_of!(RASTER))[y as usize];
        (line[0], line[1])
    }
}

// FTransform records: X, Y, Z, Flags, ScreenX, ScreenY, IntY, RZ (0x20 bytes).
const T_X: u32 = 0;
const T_Y: u32 = 4;
const T_Z: u32 = 8;
const T_FLAGS: u32 = 12;
const T_SX: u32 = 16;
const T_SY: u32 = 20;
const T_INTY: u32 = 24;
const T_RZ: u32 = 28;

/// 0x10b19cc0(Pts, NumPts, Span, FrameY): bounding box, Y clamp (which
/// rewrites the points' IntY and ScreenY), the optional box test and the
/// 16.16 edge walk into the raster lines.
fn rasterize(pts: &[u32], span: Option<&SpanBuffer>, frame_y: i32) -> bool {
    let n = pts.len();
    let first = pts[0];
    let mut start_y = rd(first + T_INTY) as i32;
    let mut end_y = start_y;
    let x = fistp(rf(first + T_SX) - 0.5);
    let (mut min_x, mut max_x) = (x, x);
    for &p in &pts[1..] {
        let y = rd(p + T_INTY) as i32;
        if y < start_y {
            start_y = y;
        } else if y > end_y {
            end_y = y;
        }
        let x = fistp(rf(p + T_SX) - 0.5);
        if x < min_x {
            min_x = x;
        } else if x > max_x {
            max_x = x;
        }
    }
    if start_y < 0 || end_y > frame_y {
        if start_y < 0 {
            start_y = 0;
        } else if start_y >= frame_y {
            start_y = frame_y;
        }
        if end_y < 0 {
            end_y = 0;
        } else if end_y >= frame_y {
            end_y = frame_y;
        }
        for &p in pts {
            let y = rd(p + T_INTY) as i32;
            let c = if y < 0 { 0 } else if y >= frame_y { frame_y } else { y };
            wr(p + T_INTY, c as u32);
            wr(p + T_SY, (c as f32).to_bits());
        }
    }
    unsafe { *addr_of_mut!(RASTER_BOX) = [start_y, end_y, min_x, max_x] };
    if let Some(span) = span {
        if !span.box_is_visible(min_x, start_y, max_x, end_y) {
            return false;
        }
    }
    let mut prev = pts[n - 1];
    for &cur in pts {
        let (cy, py) = (rd(cur + T_INTY) as i32, rd(prev + T_INTY) as i32);
        if cy != py {
            let dir = (cy > py) as usize;
            let (top, bot) = if dir == 1 { (prev, cur) } else { (cur, prev) };
            let top_y = rd(top + T_INTY) as i32;
            let slope = ((rf(bot + T_SX) - rf(top + T_SX)) * 65536.0) / (rf(bot + T_SY) - rf(top + T_SY));
            let start = (top_y as f32 - rf(top + T_SY)) * slope + rf(top + T_SX) * 65536.0;
            let mut fixed = fistp(start - 0.5);
            let step = fistp(slope - 0.5);
            let lines = rd(bot + T_INTY) as i32 - top_y;
            unsafe {
                let raster = &mut *addr_of_mut!(RASTER);
                for k in 0..lines.max(0) {
                    fixed = fixed.wrapping_add(step);
                    raster[(top_y + k) as usize][dir] = fixed >> 16;
                }
            }
        }
        prev = cur;
    }
    true
}

// ---- ClipBspSurf (0x10b14cb0; .work/occlude/frame-and-clip.md section 4) -----------------

const MAX_PTS: usize = 24;
static mut PTS: [[u32; MAX_PTS]; 6] = [[0; MAX_PTS]; 6]; // P0, PXM, PXP, PYM, PYP, PNear
static mut DIST: [f32; MAX_PTS] = [0.0; MAX_PTS];

struct View {
    origin: [f32; 3],
    axes: [[f32; 3]; 3],
    prj: [f32; 4], // XM, YM, XP, YP
    proj_z: f32,
    fx15: f32,
    fy15: f32,
}

fn project_clip(w: u32, view: &View, z: f32) {
    let rz = view.proj_z / z;
    wr(w + T_RZ, rz.to_bits());
    let sx = rz * rf(w + T_X) + view.fx15;
    let sy = rz * rf(w + T_Y) + view.fy15;
    wr(w + T_SX, sx.to_bits());
    wr(w + T_SY, sy.to_bits());
    wr(w + T_INTY, fistp(sy - 0.5) as u32);
}

/// One inlined Sutherland-Hodgman pass; distances already in DIST.
fn clip_pass(src: usize, n: usize, dst: usize, view: &View, inline_push: bool) -> usize {
    unsafe {
        let pts = &mut *addr_of_mut!(PTS);
        let dist = &*addr_of!(DIST);
        let mut m = 0;
        let mut prev = n - 1;
        for i in 0..n {
            if !sb(dist[prev]) {
                pts[dst][m] = pts[src][prev];
                m += 1;
            }
            if sb(dist[prev]) != sb(dist[i]) {
                // XM..YP call Core PushBytes(0x20, 8); the near clip pushes inline.
                let _ = inline_push;
                let w = push(GDYN, 0x20, 8);
                pts[dst][m] = w;
                m += 1;
                let (a, b) = (pts[src][i], pts[src][prev]);
                let t = dist[prev] / (dist[prev] - dist[i]);
                wr(w + T_X, ((rf(a + T_X) - rf(b + T_X)) * t + rf(b + T_X)).to_bits());
                wr(w + T_Y, ((rf(a + T_Y) - rf(b + T_Y)) * t + rf(b + T_Y)).to_bits());
                let z = (rf(a + T_Z) - rf(b + T_Z)) * t + rf(b + T_Z);
                wr(w + T_Z, z.to_bits());
                project_clip(w, view, z);
            }
            prev = i;
        }
        m
    }
}

/// ClipBspSurf: the clipped, projected polygon in PTS[result.1][..result.0].
fn clip_bsp_surf(i_node: i32, view: &View, stamp: u32) -> (usize, usize) {
    let node = Node::at(i_node);
    let count = node.num_vertices() as usize;
    let verts = model(2) + 8 * node.vert_pool();
    let points = model(4);
    let cache = model(13);
    let mut and = 0x3c_u8;
    let mut or = 0_u8;
    unsafe {
        let pts = &mut *addr_of_mut!(PTS);
        for i in 0..count {
            let pv = rd(verts + 8 * i as u32);
            let entry = cache + 8 * pv;
            if rd(entry + 4) != stamp {
                wr(entry + 4, stamp);
                let t = push(VECTOR, 0x20, 8);
                wr(entry, t);
                let p = points + 12 * pv;
                let d = [rf(p) - view.origin[0], rf(p + 4) - view.origin[1], rf(p + 8) - view.origin[2]];
                let mut v = [0.0_f32; 3];
                for (k, axis) in view.axes.iter().enumerate() {
                    v[k] = (d[0] * axis[0] + d[1] * axis[1]) + d[2] * axis[2];
                }
                wr(t + T_X, v[0].to_bits());
                wr(t + T_Y, v[1].to_bits());
                wr(t + T_Z, v[2].to_bits());
                let cxm = v[2] * view.prj[0] + v[0];
                let cym = v[2] * view.prj[1] + v[1];
                let cyp = v[2] * view.prj[3] - v[1];
                let cxp = v[2] * view.prj[2] - v[0];
                let rz = view.proj_z / v[2];
                let flags = (if sb(cxm) { 0x04 } else { 0 })
                    | (if sb(cym) { 0x10 } else { 0 })
                    | (if sb(cxp) { 0x08 } else { 0 })
                    | (if sb(cyp) { 0x20 } else { 0 });
                wr8(t + T_FLAGS, flags);
                wr(t + T_RZ, rz.to_bits());
                if flags == 0 {
                    wr(t + T_SX, (v[0] * rz + view.fx15).to_bits());
                    let sy = v[1] * rz + view.fy15;
                    wr(t + T_SY, sy.to_bits());
                    wr(t + T_INTY, fistp(sy - 0.5) as u32);
                }
            }
            let t = rd(entry);
            pts[0][i] = t;
            let flags = rd8(t + T_FLAGS);
            and &= flags;
            or |= flags;
        }
        if and != 0 {
            return (0, 0);
        }
        let dist = &mut *addr_of_mut!(DIST);
        let mut src = 0;
        let mut n = count;
        let passes: [(u8, usize); 4] = [(0x04, 1), (0x08, 2), (0x10, 3), (0x20, 4)];
        for (bit, dst) in passes {
            if or & bit == 0 {
                continue;
            }
            for i in 0..n {
                let v = pts[src][i];
                let (x, y, z) = (rf(v + T_X), rf(v + T_Y), rf(v + T_Z));
                dist[i] = match bit {
                    0x04 => z * view.prj[0] + x,
                    0x08 => z * view.prj[2] - x,
                    0x10 => z * view.prj[1] + y,
                    _ => z * view.prj[3] - y,
                };
            }
            n = clip_pass(src, n, dst, view, false);
            if n == 0 {
                return (0, 0);
            }
            src = dst;
        }
        let near = [ff(37), ff(38), ff(39), ff(40)];
        if !(near[3] == 0.0 || near[3].is_nan()) {
            let mut any = false;
            for i in 0..n {
                let v = pts[src][i];
                let e = ((near[2] * rf(v + T_Z) + near[1] * rf(v + T_Y)) + near[0] * rf(v + T_X)) - near[3];
                dist[i] = e;
                any |= !(e >= 0.0);
            }
            if any {
                n = clip_pass(src, n, 5, view, true);
                if n == 0 {
                    return (0, 0);
                }
                src = 5;
            }
        }
        (n, src)
    }
}

// ---- BoundVisible, perspective (0x10b162e0..0x10b170d0) --------------------------

/// Returns the integer screen box (before clamping) or None.
fn bound_visible(bound: u32, view: &View, width: i32, height: i32, fx2: f32, fy2: f32) -> Option<[i32; 4]> {
    let min = [rf(bound), rf(bound + 4), rf(bound + 8)];
    let max = [rf(bound + 12), rf(bound + 16), rf(bound + 20)];
    let lo = [min[0] - view.origin[0], min[1] - view.origin[1], min[2] - view.origin[2]];
    let hi = [max[0] - view.origin[0], max[1] - view.origin[1], max[2] - view.origin[2]];
    if (0..3).all(|i| lo[i] <= 0.0 && hi[i] >= 0.0) {
        return Some([0, 0, width, height]);
    }
    let mut a = [[0.0_f32; 3]; 3];
    let mut b = [[0.0_f32; 3]; 3];
    for row in 0..3 {
        for i in 0..3 {
            a[row][i] = lo[i] * view.axes[row][i];
            b[row][i] = hi[i] * view.axes[row][i];
        }
    }
    if [a[2][0], a[2][1], a[2][2], b[2][0], b[2][1], b[2][2]].iter().all(|v| *v < 0.0) {
        return None;
    }
    let s3 = |x: f32, y: f32, z: f32| (x + y) + z;
    let mut points = [[0.0_f32; 3]; 8];
    for r in 0..3 {
        points[0][r] = s3(a[r][0], a[r][1], a[r][2]);
        points[1][r] = s3(b[r][0], a[r][1], a[r][2]);
        points[2][r] = s3(b[r][1], a[r][0], a[r][2]);
        points[3][r] = s3(b[r][0], b[r][1], a[r][2]);
        points[4][r] = s3(b[r][2], a[r][0], a[r][1]);
        points[5][r] = s3(b[r][0], b[r][2], a[r][1]);
    }
    points[6] = [a[0][0] + (b[0][1] + b[0][2]), (b[1][1] + b[1][2]) + a[1][0], a[2][0] + (b[2][1] + b[2][2])];
    points[7] = [b[0][0] + (b[0][1] + b[0][2]), (b[1][1] + b[1][2]) + b[1][0], b[2][0] + (b[2][1] + b[2][2])];
    let (mut and, mut or) = (15_u32, 0_u32);
    for p in &points {
        let (x, y, z) = (p[0], p[1], p[2]);
        let code = (if z * view.prj[0] + x < 0.0 { 1 } else { 0 })
            | (if z * view.prj[2] - x < 0.0 { 2 } else { 0 })
            | (if z * view.prj[1] + y < 0.0 { 4 } else { 0 })
            | (if z * view.prj[3] - y < 0.0 { 8 } else { 0 });
        and &= code;
        or |= code;
    }
    if and != 0 {
        return None;
    }
    let project = |p: &[f32; 3]| {
        let q = view.proj_z / p[2];
        (fistp((q * p[0] + fx2) - 0.5), fistp((q * p[1] + fy2) - 0.5))
    };
    let first = project(&points[0]);
    let mut x1 = if or & 1 != 0 { 0 } else { first.0 };
    let mut x2 = if or & 2 != 0 { width } else { first.0 };
    let mut y1 = if or & 4 != 0 { 0 } else { first.1 };
    let mut y2 = if or & 8 != 0 { height } else { first.1 };
    for p in &points[..7] {
        let (x, y) = project(p);
        if x < x1 {
            x1 = x;
        } else if x > x2 {
            x2 = x;
        }
        if y < y1 {
            y1 = y;
        } else if y > y2 {
            y2 = y;
        }
    }
    Some([x1, y1, x2, y2])
}

// ---- output ----------------------------------------------------------------------

fn emit(value: u32) {
    let at = push(OUT, 4, 4);
    wr(at, value);
}

// Draw list records (GDynMem words): iNode, iSurf, iZone, PolyFlags, zone
// key, Next, SurfNext, Polys. Saved polys: Next, iNode, NumPts, Pts...
const DL_WORDS: u32 = 8;

// ---- OccludeBsp --------------------------------------------------------------

const ZONES: usize = 64;

/// Run OccludeBsp on the frame words. `work` is a host block of `bytes`.
#[no_mangle]
pub extern "C" fn occ_run(work: u32, bytes: u32) -> i32 {
    unsafe {
        *addr_of_mut!(OVERFLOW) = false;
        // Partition: GMem, GDynMem, GSceneMem, VectorMem, output.
        let part = (bytes / 5) & !15;
        let arenas = &mut *addr_of_mut!(ARENA);
        for (i, arena) in arenas.iter_mut().enumerate() {
            let base = work + part * i as u32;
            *arena = [base, base, base + part];
        }
        // Arena bases are never NULL; keep 0 meaning NULL.
        let status = &mut *addr_of_mut!(STATUS);
        *status = [0; 8];
        let result = occlude();
        status[0] = if *addr_of!(OVERFLOW) { 2 } else { result };
        status[1] = (arena_top(OUT) - arenas[OUT][0]) / 4;
        status[5] = arenas[OUT][0];
        status[0] as i32
    }
}

#[allow(unused_assignments)]
fn occlude() -> u32 {
    let num_nodes = model(1);
    if num_nodes == 0 {
        return 0;
    }
    let view = View {
        origin: [ff(0), ff(1), ff(2)],
        axes: [[ff(3), ff(4), ff(5)], [ff(6), ff(7), ff(8)], [ff(9), ff(10), ff(11)]],
        prj: [ff(21), ff(22), ff(23), ff(24)],
        proj_z: ff(20),
        fx15: ff(14),
        fy15: ff(15),
    };
    let (width, height) = (frame(12) as i32, frame(13) as i32);
    if height < 0 || height as usize >= RASTER_LINES {
        // The raster lines end at 0x10b56608: taller frames overrun them.
        return 3;
    }
    let (fx2, fy2) = (ff(16), ff(17));
    let zone_number = frame(42) as u8;
    let mask8: u8 = if zone_number != 0 { 0xff } else { 0 };
    let mirror_neg = frame(41) == 0xbf80_0000;
    let options = frame(46);
    let toggle = options & 4 != 0;
    let time_bits = frame(45);
    let frame_counter = frame(44);
    let extra_flags = frame(47);
    let origin = view.origin;
    let surfs = model(6);
    let zones = model(10);
    let level_key = model(15);
    let zone_key = |z: u8| {
        let k = rd(zones + 16 * z as u32);
        if k != 0 { k } else { level_key }
    };
    // Stamp++ (0x10b17479).
    let stamp = model(14).wrapping_add(1);
    unsafe { (*addr_of_mut!(MODEL))[14] = stamp };

    // SurfDrawList (GMem, zeroed) and the template FBspDrawList (GMem 0x4c).
    let num_surfs = model(7);
    let surf_lists = push(GMEM, 4 * num_surfs, 8);
    for i in 0..num_surfs {
        wr(surf_lists + 4 * i, 0);
    }
    let mut draw: [u32; 3] = [0; 3];
    let (mut nodes_draw, mut polys_draw) = (0_u32, 0_u32);
    let mut children = 0_u32;

    // Zones[ZoneNumber].LastRenderTime = TimeSeconds (0x10b1768d).
    wr(zones + 16 * zone_number as u32 + 4, time_bits);

    // The screen span (CreateMasterFrame, GSceneMem) and the 64 zone spans.
    let mut zone_spans = [EMPTY; ZONES];
    for span in zone_spans.iter_mut() {
        span.alloc_index(0, 0, GDYN);
    }
    let mut screen = EMPTY;
    screen.alloc_index_for_screen(width, height, GSCENE);
    zone_spans[zone_number as usize] = screen;
    // SetupDynamics' sprites (0x10b22d90; FDynamicSprite 0x10b233c0), in
    // Level.Actors order, each with its chunk at the head of node 0.
    let mut frame_sprite = 0_u32;
    setup_sprites();
    let mut active: [u8; ZONES] = [0; ZONES];
    active[0] = zone_number;
    let mut active_count = 1_usize;
    let mut active_mask: u64 = 1u64 << (zone_number & 63);

    // Traversal entries (GMem 0x18): iNode, iFar, FarOutside, Outside, State, Prev.
    let new_entry = |prev: u32| {
        let e = push(GMEM, 0x18, 8);
        wr(e + 20, prev);
        e
    };
    let mut entry = new_entry(0);
    let mut i_node: i32 = 0;
    let mut outside = model(12) != 0;
    let mut state = 0_u32;
    'traverse: loop {
        let node = Node::at(i_node);
        // `chain` = the node whose polygon chain is processed (state 1).
        let process_chain: bool;
        if state == 0 {
            if zone_number != 0 && node.zone_mask() & active_mask == 0 {
                // pop
                state = 2;
            }
            if state == 0 && node.render_bound() != -1 {
                let skip_test = node.flags() & 0x10 == 0 && (frame_counter ^ i_node as u32) & 0xf != 0;
                if !skip_test {
                    node.set_flags(node.flags() & !0x10);
                    let bound = model(8) + 28 * node.render_bound() as u32;
                    let span = if zone_number != 0 { None } else { Some(&zone_spans[0]) };
                    let visible = match bound_visible(bound, &view, width, height, fx2, fy2) {
                        None => None,
                        Some(b) => {
                            let clamped = [b[0].max(0), b[1].max(0), b[2].min(width), b[3].min(height)];
                            match span {
                                Some(s) if !s.box_is_visible(b[0], b[1], b[2], b[3]) => None,
                                _ => Some(clamped),
                            }
                        }
                    };
                    match visible {
                        None => {
                            node.set_flags(node.flags() | 0x10);
                            state = 2;
                        }
                        Some(c) => {
                            if zone_number != 0 {
                                let mut seen = false;
                                for &z in &active[..active_count] {
                                    if node.zone_mask() & (1u64 << (z & 63)) != 0
                                        && zone_spans[z as usize].box_is_visible(c[0], c[1], c[2], c[3])
                                    {
                                        seen = true;
                                        break;
                                    }
                                }
                                if !seen {
                                    node.set_flags(node.flags() | 0x10);
                                    state = 2;
                                }
                            }
                        }
                    }
                }
            }
            if state == 0 {
                // Dynamics[0]: filter the pending chunks (0x10b17c1a).
                filter_chunks(i_node, outside);
                let is_front = node.distance(origin) > 0.0;
                let f = is_front as u32;
                wr(entry + 4, node.child(1 - f) as u32);
                wr(entry + 8, node.child_outside(1 - f, outside) as u32);
                let near = node.child(f);
                if near != -1 {
                    wr(entry + 12, outside as u32);
                    wr(entry, i_node as u32);
                    wr(entry + 16, 1);
                    entry = new_entry(entry);
                    i_node = near;
                    outside = node.child_outside(f, outside);
                    continue 'traverse;
                }
                process_chain = true;
            } else {
                process_chain = false;
            }
        } else {
            process_chain = state == 1;
            if process_chain && zone_number != 0 && node.zone_mask() & active_mask == 0 {
                // GStat, pop.
                state = 2;
            }
        }

        if state != 2 && process_chain {
            // State 1: the node's coplanar chain (0x10b17d80).
            let head = i_node;
            let dist = node.distance(origin);
            let mut is_front = dist > 0.0;
            let zone = node.zone(is_front as u32) & mask8;
            if zone_spans[zone as usize].valid != 0 && (node.child_outside(is_front as u32, outside) || toggle) {
                // Dynamics[1-IsFront] PreRender (0x10b17e72).
                pre_render(i_node, 1 - is_front as u32, &mut zone_spans[zone as usize], &mut frame_sprite);
            }
            let sign: f32 = if is_front { 1.0 } else { -1.0 };
            let normal = [node.plane(0), node.plane(1), node.plane(2)];
            let mut facing = false;
            for k in 0..4 {
                let side = [ff(25 + 3 * k), ff(26 + 3 * k), ff(27 + 3 * k)];
                let s = ((side[2] * normal[2] + side[1] * normal[1]) + side[0] * normal[0]) * sign;
                if !(s > 0.0) {
                    facing = true;
                    break;
                }
            }
            if !facing {
                state = 2;
            } else {
                let mut cur = i_node;
                let mut cur_dist = dist;
                'chain: loop {
                    let cnode = Node::at(cur);
                    'poly: {
                        let surf = surfs + 8 * cnode.surf() as u32;
                        let mut poly_flags = rd(surf) | extra_flags;
                        if !is_front && cur_dist < -1.0 && poly_flags & 0x0400_0100 == 0 {
                            break 'poly;
                        }
                        if poly_flags & 0x0400_0000 != 0 && zone_number == 0 {
                            break 'poly;
                        }
                        let zone = cnode.zone(is_front as u32) & mask8;
                        if zone_spans[zone as usize].valid <= 0 {
                            break 'poly;
                        }
                        let (count, src) = clip_bsp_surf(cur, &view, stamp);
                        if count == 0 {
                            break 'poly;
                        }
                        let pts = unsafe { &mut (&mut *addr_of_mut!(PTS))[src][..count] };
                        let backface = !is_front && poly_flags & 0x0400_0100 != 0;
                        if backface != mirror_neg {
                            pts.reverse();
                        }
                        let test = if cnode.flags() & 8 != 0 { Some(&zone_spans[zone as usize]) } else { None };
                        if !rasterize(pts, test, height) {
                            break 'poly;
                        }
                        poly_flags |= rd(surf + 4); // Texture->PolyFlags (0 without a texture)
                        // [ebp-0x1b0]: PF_Invisible survives only with ShowFlags & 0x800.
                        if options & 1 == 0 {
                            poly_flags &= !1;
                        }
                        let occluding = poly_flags & 0x0401_0047 == 0;
                        let actor = zone_key(cnode.zone(is_front as u32));
                        let mut existing = 0_u32;
                        if occluding {
                            let mut dl = rd(surf_lists + 4 * cnode.surf() as u32);
                            while dl != 0 && rd(dl + 16) != actor {
                                dl = rd(dl + 24);
                            }
                            existing = dl;
                        }
                        let (start_y, end_y) = unsafe { ((*addr_of!(RASTER_BOX))[0], (*addr_of!(RASTER_BOX))[1]) };
                        let mut tspan = EMPTY;
                        tspan.alloc_index(start_y, end_y, GMEM);
                        let composited = poly_flags & 0x47;
                        let accepted = if composited != 0
                            && poly_flags & 0x0400_0001 != 0x0400_0001
                            && poly_flags & 0x0800_0000 == 0
                        {
                            tspan.copy_from_raster(&mut zone_spans[zone as usize], start_y, end_y, false, 0)
                        } else {
                            tspan.copy_from_raster(&mut zone_spans[zone as usize], start_y, end_y, true, 0)
                        };
                        let mut list = if composited != 0 { 2_usize } else { 1 };
                        if !accepted {
                            cnode.set_flags(cnode.flags() | 8);
                            tspan.release();
                            break 'poly;
                        }
                        if poly_flags & 0x80 != 0
                            && rd(zones + 16 * zone as u32 + 8) != 0
                            && frame(43) < 3
                            && options & 1 != 0
                        {
                            // PF_FakeBackdrop with the zone's SkyZone: the sky frame
                            // (0x10b18390..0x10b1882f), then the next coplanar without
                            // a draw list or Release. Its occlusion is not run here yet.
                            emit_child(1, cur, 0, zone, &tspan);
                            children += 1;
                            break 'poly;
                        }
                        if poly_flags & 0x0800_0000 != 0 && frame(43) < 3 && options & 1 != 0 {
                            // Mirror (0x10b1886d..0x10b18b93): the child frame request.
                            if poly_flags & 4 != 0 && options & 2 == 0 {
                                poly_flags = (poly_flags & !4) | 0x8000_0000;
                                list = 1;
                            } else {
                                emit_child(0, cur, 0, zone, &tspan);
                                children += 1;
                                list = 0;
                                if composited == 0 {
                                    poly_flags |= 1;
                                }
                                poly_flags |= 0x8000_0000;
                            }
                        } else if poly_flags & 0x0400_0000 != 0 {
                            // Portal (0x10b18bd1).
                            let drawn = poly_flags & 1 == 0;
                            let far = cnode.zone(1 - is_front as u32) & mask8;
                            if far != 0 && composited != 0 {
                                let bit = 1u64 << (far & 63);
                                if active_mask | bit != active_mask {
                                    active[active_count] = far;
                                    active_count += 1;
                                }
                                active_mask |= bit;
                                if drawn {
                                    let copy = tspan.copy_lines(GDYN);
                                    zone_spans[far as usize].merge_with(&copy);
                                } else {
                                    zone_spans[far as usize].merge_with(&tspan);
                                }
                                wr(zones + 16 * far as u32 + 4, time_bits);
                            }
                            // 0x10b193e1: an invisible portal goes to the next
                            // coplanar (no Release); a drawn one gets a new list.
                            if !drawn {
                                break 'poly;
                            }
                            existing = 0;
                        } else if poly_flags & 1 != 0 {
                            // 0x10b193f2: no Release.
                            break 'poly;
                        }
                        // The draw list (0x10b193fb); D3D is not span based.
                        let saved = push(GDYN, 12 + 4 * count as u32, 8);
                        wr(saved + 4, cur as u32);
                        wr(saved + 8, count as u32);
                        for (k, &p) in pts.iter().enumerate() {
                            wr(saved + 12 + 4 * k as u32, p);
                        }
                        if existing == 0 {
                            let dl = push(GDYN, 4 * DL_WORDS, 8);
                            wr(dl, cur as u32);
                            wr(dl + 4, cnode.surf() as u32);
                            wr(dl + 8, cnode.zone(is_front as u32) as u32);
                            wr(dl + 12, poly_flags);
                            wr(dl + 16, actor);
                            wr(dl + 20, draw[list]);
                            let surf_slot = surf_lists + 4 * cnode.surf() as u32;
                            wr(dl + 24, rd(surf_slot));
                            wr(surf_slot, dl);
                            wr(saved, 0);
                            wr(dl + 28, saved);
                            draw[list] = dl;
                            // URender+0x6c counts new lists (0x10b197db).
                            polys_draw += 1;
                        } else {
                            wr(saved, rd(existing + 28));
                            wr(existing + 28, saved);
                        }
                        tspan.release();
                        cnode.set_flags(cnode.flags() & !8);
                        nodes_draw += 1;
                        if zone_spans[zone as usize].valid <= 0 {
                            // The zone is full: drop it from the active list.
                            let mut kept = 0;
                            for k in 0..active_count {
                                if active[k] != zone {
                                    active[kept] = active[k];
                                    kept += 1;
                                }
                            }
                            active_count = kept;
                            active_mask &= !(1u64 << (zone & 63));
                            if kept == 0 {
                                break 'traverse;
                            }
                        }
                    }
                    // Next coplanar (0x10b19a53).
                    let next = Node::at(cur).coplanar();
                    if next == -1 {
                        break 'chain;
                    }
                    cur = next;
                    cur_dist = Node::at(cur).distance(origin);
                    is_front = cur_dist > 0.0;
                }
                // After the chain: the head's far side (0x10b19a65).
                let hnode = Node::at(head);
                let head_front = hnode.distance(origin) > 0.0;
                let far = hnode.zone(1 - head_front as u32) & mask8;
                if zone_spans[far as usize].valid != 0
                    && (hnode.child_outside(1 - head_front as u32, outside) || toggle)
                {
                    // Dynamics[IsFront] PreRender (0x10b19b37).
                    pre_render(head, head_front as u32, &mut zone_spans[far as usize], &mut frame_sprite);
                }
                let i_far = rd(entry + 4) as i32;
                if i_far != -1 {
                    i_node = i_far;
                    outside = rd(entry + 8) != 0;
                    state = 0;
                    continue 'traverse;
                }
                state = 2;
            }
        }
        // Pop (0x10b19be9).
        let prev = rd(entry + 20);
        if prev == 0 {
            break 'traverse;
        }
        entry = prev;
        i_node = rd(entry) as i32;
        outside = rd(entry + 12) != 0;
        state = rd(entry + 16);
    }
    // Output: Draw[0..2] (newest first), each with its polys (newest first).
    for list in 0..3 {
        let mut dl = draw[list];
        while dl != 0 {
            emit(list as u32);
            for k in 0..5 {
                emit(rd(dl + 4 * k));
            }
            let mut saved = rd(dl + 28);
            let mut polys = 0;
            let mut s = saved;
            while s != 0 {
                polys += 1;
                s = rd(s);
            }
            emit(polys);
            while saved != 0 {
                let count = rd(saved + 8);
                emit(rd(saved + 4));
                emit(if options & 0x100 != 0 { count } else { 0 });
                for k in 0..if options & 0x100 != 0 { count } else { 0 } {
                    let p = rd(saved + 12 + 4 * k);
                    for f in [T_X, T_Y, T_Z, T_SX, T_SY, T_INTY, T_RZ] {
                        emit(rd(p + f));
                    }
                }
                saved = rd(saved);
            }
            dl = rd(dl + 20);
        }
    }
    // Frame->Sprite (RenderNext order) with each sprite's span buffer.
    let mut s = frame_sprite;
    while s != 0 {
        emit(0xffff_fffe);
        emit(rd(s + 4 * SP_KEY));
        let span = sprite_span(s);
        emit(span.start_y as u32);
        emit(span.end_y as u32);
        emit(span.valid as u32);
        for y in span.start_y..span.end_y {
            let mut n = 0;
            let mut t = rd(span.line(y));
            while t != 0 {
                n += 1;
                t = s_next(t);
            }
            emit(n);
            let mut t = rd(span.line(y));
            while t != 0 {
                emit(s_start(t) as u32);
                emit(s_end(t) as u32);
                t = s_next(t);
            }
        }
        s = rd(s + 4 * SP_RENDER_NEXT);
    }
    unsafe {
        let status = &mut *addr_of_mut!(STATUS);
        status[2] = nodes_draw;
        status[3] = polys_draw;
        status[4] = children;
    }
    0
}

/// A child frame request: kind (0 mirror, 1 sky), iNode, iSurf, zone, the
/// span's StartY, EndY, ValidLines, then per line its span count and spans.
/// Children go to a separate stream after the draw lists: they are emitted
/// into the output in request order, prefixed by 0xffffffff.
fn emit_child(kind: u32, i_node: i32, i_surf: i32, zone: u8, span: &SpanBuffer) {
    emit(0xffff_ffff);
    emit(kind);
    emit(i_node as u32);
    emit(i_surf as u32);
    emit(zone as u32);
    emit(span.start_y as u32);
    emit(span.end_y as u32);
    emit(span.valid as u32);
    for y in span.start_y..span.end_y {
        let mut n = 0;
        let mut s = rd(span.line(y));
        while s != 0 {
            n += 1;
            s = s_next(s);
        }
        emit(n);
        let mut s = rd(span.line(y));
        while s != 0 {
            emit(s_start(s) as u32);
            emit(s_end(s) as u32);
            s = s_next(s);
        }
    }
}

// ---- the master frame (CreateMasterFrame 0x10b15690) -----------------------------
//
// Built before URender::PreRender, at the game thread's precision (the
// model of docs/script-window-scene-frame.md: 64-bit significands), with
// the x87 model in x87.rs. ComputeRenderCoords (Engine 0x10372580) rotates
// GMath.ViewCoords by the camera rotation and adds the location; Uncoords
// is its transpose. ComputeRenderSize (Engine 0x10372980) gives the sizes,
// projection, clip numbers, ViewSides and ViewPlanes; UModel::PointRegion
// (Engine 0x103f5db0) the zone at the origin.

use crate::x87::Ext;

/// Input: location bits (3), rotation (3 int32), width, height, FOV bits,
/// Core appTan's qword result (low, high), Actor.OrthoZoom bits.
static mut MASTER_IN: [u32; 12] = [0; 12];
/// Output: the FSceneNode words Coords (+0x34, 12), FX..PrjYP (+0xb8, 17),
/// ViewSides and ViewPlanes (+0xfc, 28), ZoneNumber, then Uncoords (+0x64, 12).
static mut MASTER_OUT: [u32; 70] = [0; 70];

#[no_mangle]
pub extern "C" fn occ_master_in_ptr() -> *mut u32 {
    addr_of_mut!(MASTER_IN) as *mut u32
}
#[no_mangle]
pub extern "C" fn occ_master_out_ptr() -> *const u32 {
    addr_of!(MASTER_OUT) as *const u32
}

fn ld(bits: u32) -> Ext {
    Ext::load(bits)
}
fn sub(a: Ext, b: Ext) -> Ext {
    a.add(b.neg())
}
/// ((v.x*a.x + v.y*a.y) + v.z*a.z), stored.
fn dot3(v: [Ext; 3], a: [u32; 3]) -> u32 {
    v[0].mul(ld(a[0])).add(v[1].mul(ld(a[1]))).add(v[2].mul(ld(a[2]))).store()
}

/// ComputeRenderCoords' view coordinates (script-window-scene-frame.mjs
/// viewCoords, Core FCoords::operator/=(FRotator) 0x1011b690).
fn view_coords(rotation: [i32; 3], location: [u32; 3]) -> [u32; 12] {
    let s = |angle: i32| crate::rotator_sin(angle);
    let c = |angle: i32| crate::rotator_sin(angle.wrapping_add(0x4000));
    let neg = |bits: u32| bits ^ 0x8000_0000;
    let (pitch, yaw, roll) = (rotation[0], rotation[1], rotation[2]);
    let one = 0x3f80_0000;
    let passes: [[[u32; 3]; 4]; 3] = [
        [[0, 0, 0], [one, 0, 0], [0, c(roll), s(roll)], [0, neg(s(roll)), c(roll)]],
        [[0, 0, 0], [c(pitch), 0, neg(s(pitch))], [0, one, 0], [s(pitch), 0, c(pitch)]],
        [[0, 0, 0], [c(yaw), neg(s(yaw)), 0], [s(yaw), c(yaw), 0], [0, 0, one]],
    ];
    let mut fields: [[u32; 3]; 4] = [[0, 0, 0], [0, one, 0], [0, 0, neg(one)], [one, 0, 0]];
    for m in &passes {
        let mut next = [[0u32; 3]; 4];
        for i in 0..4 {
            let v: [Ext; 3] = if i == 0 {
                [sub(ld(fields[0][0]), ld(m[0][0])), sub(ld(fields[0][1]), ld(m[0][1])), sub(ld(fields[0][2]), ld(m[0][2]))]
            } else {
                [ld(fields[i][0]), ld(fields[i][1]), ld(fields[i][2])]
            };
            next[i] = [dot3(v, m[1]), dot3(v, m[2]), dot3(v, m[3])];
        }
        fields = next;
    }
    for k in 0..3 {
        fields[0][k] = ld(fields[0][k]).add(ld(location[k])).store();
    }
    let mut out = [0u32; 12];
    for i in 0..4 {
        out[3 * i..3 * i + 3].copy_from_slice(&fields[i]);
    }
    out
}

/// PointRegion's zone number: dist = ((z*Pz + y*Py) + x*Px) - W; the back
/// side when below 0 or unordered (0x103f5e23..0x103f5e4b).
fn point_zone(p: [u32; 3]) -> u32 {
    let count = model(1);
    if count == 0 {
        return 0;
    }
    let mut index: i32 = 0;
    let mut last = 0;
    let mut side = 0;
    let mut visits = 0;
    while index != -1 && visits <= count {
        let node = Node::at(index);
        let d = sub(
            ld(p[2]).mul(ld(rd(node.0 + 8))).add(ld(p[1]).mul(ld(rd(node.0 + 4)))).add(ld(p[0]).mul(ld(rd(node.0)))),
            ld(rd(node.0 + 12)),
        );
        let (below, _) = d.compare(Ext::zero(0));
        side = if below { 0 } else { 1 };
        last = index;
        index = node.child(side);
        visits += 1;
    }
    if model(11) == 0 { 0 } else { Node::at(last).zone(side) as u32 }
}

#[no_mangle]
pub extern "C" fn occ_master_frame() {
    let input = unsafe { *addr_of!(MASTER_IN) };
    let location = [input[0], input[1], input[2]];
    let rotation = [input[3] as i32, input[4] as i32, input[5] as i32];
    let (width, height) = (input[6] as i32, input[7] as i32);
    let coords = view_coords(rotation, location);
    // Uncoords axes: the transpose.
    let un = [
        [coords[3], coords[6], coords[9]],
        [coords[4], coords[7], coords[10]],
        [coords[5], coords[8], coords[11]],
    ];
    let half = Ext::load_f64(0.5);
    let xi = Ext::load_i32(width);
    let fx = xi.store();
    let fy = Ext::load_i32(height).store();
    let fx2 = xi.mul(half).store();
    let fy2 = ld(fy).mul(half).store();
    let c10001 = Ext::load_f64(f64::from_bits(0x3ff0_0068_db8b_ac71));
    let fx15 = xi.add(c10001).mul(half).store();
    let fy15 = ld(fy).add(c10001).mul(half).store();
    let tan = Ext::load_f64(f64::from_bits(input[9] as u64 | (input[10] as u64) << 32));
    let hx = ld(fx).mul(half);
    let proj_z = hx.div(tan).store();
    let proj_y = sub(half, ld(fy).mul(half)).store();
    let proj_x = sub(half, hx).store();
    let one = ld(0x3f80_0000);
    let rproj = [one.div(ld(proj_x)).store(), one.div(ld(proj_y)).store(), one.div(ld(proj_z)).store()];
    let zoom = ld(input[11]).div(ld(fx).mul(Ext::load_f64(15.0))).store();
    let neg_rz = ld(rproj[2]).neg();
    let prj_xm = ld(fx2).neg().mul(neg_rz).store();
    let prj_xp = sub(ld(fx), ld(fx2)).mul(ld(rproj[2])).store();
    let prj_ym = ld(fy2).neg().mul(neg_rz).store();
    let prj_yp = sub(ld(fy), ld(fy2)).mul(ld(rproj[2])).store();
    let rot = |v: [u32; 3]| -> [u32; 3] {
        let e = [ld(v[0]), ld(v[1]), ld(v[2])];
        [dot3(e, un[0]), dot3(e, un[1]), dot3(e, un[2])]
    };
    let signs = [0xbf80_0000_u32, 0x3f80_0000];
    let o = [ld(coords[0]), ld(coords[1]), ld(coords[2])];
    let mut sides = [[0u32; 3]; 4];
    let mut planes = [[0u32; 4]; 4];
    let unit = Ext::load_f64(1.0);
    let inverse_root = |sum: Ext| unit.div(sum.store_double().sqrt().store_double());
    for k in 0..2 {
        for j in 0..2 {
            let a = ld(signs[k]).mul(ld(fx2)).store();
            let b = ld(signs[j]).mul(ld(fy2)).store();
            let c = proj_z;
            let inv = inverse_root(ld(a).mul(ld(a)).add(ld(b).mul(ld(b))).add(ld(c).mul(ld(c))));
            let v = [inv.mul(ld(a)).store(), inv.mul(ld(b)).store(), inv.mul(ld(c)).store()];
            sides[j + 2 * k] = rot(v);
        }
        let p = ld(signs[k]).div(ld(fy2)).store();
        let q = one.div(ld(proj_z)).store();
        let inv = inverse_root(ld(p).mul(ld(p)).add(ld(q).mul(ld(q))));
        let n = rot([0, ld(inv.store()).mul(ld(p)).store(), inv.mul(ld(q)).store()]);
        let w = ld(n[0]).mul(o[0]).add(o[2].mul(ld(n[2]))).add(o[1].mul(ld(n[1]))).store();
        planes[k] = [n[0], n[1], n[2], w];
        let p2 = ld(signs[k]).div(ld(fx2)).store();
        let q2 = one.div(ld(proj_z)).store();
        let inv2 = inverse_root(ld(p2).mul(ld(p2)).add(ld(q2).mul(ld(q2))));
        let m = rot([inv2.mul(ld(p2)).store(), 0, inv2.mul(ld(q2)).store()]);
        let w2 = ld(m[0]).mul(o[0]).add(o[1].mul(ld(m[1]))).add(o[2].mul(ld(m[2]))).store();
        planes[k + 2] = [m[0], m[1], m[2], w2];
    }
    let zone = point_zone([coords[0], coords[1], coords[2]]);
    // Uncoords: Core FCoords::Transpose (0x1011a140): the axes transposed and
    // the origin -(O·X, O·Y, O·Z), each ((x + y) + z) stored, then negated.
    let o3 = [ld(coords[0]), ld(coords[1]), ld(coords[2])];
    let mut uncoords = [0u32; 12];
    for n in 0..3 {
        uncoords[n] = dot3(o3, [coords[3 + 3 * n], coords[4 + 3 * n], coords[5 + 3 * n]]) ^ 0x8000_0000;
    }
    for n in 0..3 {
        uncoords[3 + 3 * n..6 + 3 * n].copy_from_slice(&un[n]);
    }
    unsafe {
        let out = &mut *addr_of_mut!(MASTER_OUT);
        out[..12].copy_from_slice(&coords);
        out[12..29].copy_from_slice(&[
            fx, fy, fx15, fy15, fx2, fy2, zoom, proj_x, proj_y, proj_z, rproj[0], rproj[1], rproj[2], prj_xm, prj_ym,
            prj_xp, prj_yp,
        ]);
        for i in 0..4 {
            out[29 + 3 * i..32 + 3 * i].copy_from_slice(&sides[i]);
            out[41 + 4 * i..45 + 4 * i].copy_from_slice(&planes[i]);
        }
        out[57] = zone;
        out[58..70].copy_from_slice(&uncoords);
        // The frame words occ_run reads.
        let f = &mut *addr_of_mut!(FRAME);
        f[..12].copy_from_slice(&coords);
        f[12] = width as u32;
        f[13] = height as u32;
        f[14..20].copy_from_slice(&[fx15, fy15, fx2, fy2, fx, fy]);
        f[20] = proj_z;
        f[21..25].copy_from_slice(&[prj_xm, prj_ym, prj_xp, prj_yp]);
        for i in 0..4 {
            f[25 + 3 * i..28 + 3 * i].copy_from_slice(&sides[i]);
        }
        f[37..41].copy_from_slice(&[0, 0, 0, 0]);
        f[41] = 0x3f80_0000;
        f[42] = zone;
        f[43] = 0;
        f[48..60].copy_from_slice(&uncoords);
        f[60] = rproj[2];
    }
}


// ---- dynamics: sprites and chunks (.work/occlude/dynamics-and-drawframe.md) -----------
//
// FDynamicSprite (0x10b233c0) after Setup: the screen rectangle and depth are
// host inputs (Setup's mesh bounds and sprite path are separate). Records in
// GDynMem, word indices:
// sprite: key, X1, Y1, X2, Y2, Z, proxies (4 × X, Y, Z, ScreenX, ScreenY),
// span-buffer present, RenderNext, span buffer (7 words), raster.
const SP_KEY: u32 = 0;
const SP_Z: u32 = 5;
const SP_PROXY: u32 = 6;
const SP_HAS_SPAN: u32 = 26;
const SP_RENDER_NEXT: u32 = 27;
const SP_SPAN: u32 = 28;
const SP_WORDS: u32 = 36;
// chunk and final chunk: next, sprite, raster, Z.
// raster (FRasterPoly): StartY, EndY, then [X0, X1] per line.

fn poly_line(raster: u32, y: i32) -> (i32, i32) {
    let at = raster + 8 + 8 * (y - rd(raster) as i32) as u32;
    (rd(at) as i32, rd(at + 4) as i32)
}
fn new_raster(start_y: i32, end_y: i32) -> u32 {
    let r = push(GDYN, 8 * (end_y - start_y).max(0) as u32 + 8, 8);
    wr(r, start_y as u32);
    wr(r + 4, end_y as u32);
    r
}
fn set_line(raster: u32, index: i32, x0: i32, x1: i32) {
    let at = raster + 8 + 8 * index as u32;
    wr(at, x0 as u32);
    wr(at + 4, x1 as u32);
}
fn dyn_slot(i_node: i32, slot: u32) -> u32 {
    model(16) + 12 * i_node as u32 + 4 * slot
}
fn sprite_span(s: u32) -> SpanBuffer {
    let b = s + 4 * SP_SPAN;
    SpanBuffer {
        start_y: rd(b) as i32,
        end_y: rd(b + 4) as i32,
        valid: rd(b + 8) as i32,
        index: rd(b + 12),
        mem: rd(b + 16) as usize,
        mark_mem: rd(b + 20) as usize,
        mark_top: rd(b + 24),
    }
}
fn set_sprite_span(s: u32, span: &SpanBuffer) {
    let b = s + 4 * SP_SPAN;
    for (k, v) in [span.start_y as u32, span.end_y as u32, span.valid as u32, span.index, span.mem as u32,
        span.mark_mem as u32, span.mark_top].iter().enumerate()
    {
        wr(b + 4 * k as u32, *v);
    }
}
/// Prepend a pending chunk to a node (FDynamicChunk 0x10b23da0).
fn new_chunk(i_node: i32, sprite: u32, raster: u32) {
    let c = push(GDYN, 16, 8);
    let slot = dyn_slot(i_node, 0);
    wr(c, rd(slot));
    wr(c + 4, sprite);
    wr(c + 8, raster);
    wr(slot, c);
}
/// FDynamicFinalChunk (0x10b24690): ascending Z, a later equal Z first.
fn new_final(i_node: i32, sprite: u32, raster: u32, back: u32) {
    let c = push(GDYN, 16, 8);
    let z = rf(sprite + 4 * SP_Z);
    wr(c + 4, sprite);
    wr(c + 8, raster);
    wr(c + 12, z.to_bits());
    let mut link = dyn_slot(i_node, 1 + back);
    loop {
        let next = rd(link);
        if next == 0 {
            break;
        }
        let item_z = rf(next + 12);
        if !(item_z < z || item_z.is_nan() || z.is_nan()) {
            break;
        }
        link = next;
    }
    wr(c, rd(link));
    wr(link, c);
}

fn setup_sprites() {
    let table = model(16);
    if table == 0 {
        return;
    }
    for i in 0..3 * model(1) {
        wr(table + 4 * i, 0);
    }
    let (input, count) = (model(17), model(18));
    let rproj_z = ff(60);
    let (fx2, fy2) = (ff(16), ff(17));
    let uo = [ff(48), ff(49), ff(50)];
    let ux = [[ff(51), ff(52), ff(53)], [ff(54), ff(55), ff(56)], [ff(57), ff(58), ff(59)]];
    for i in 0..count {
        let rec = input + 24 * i;
        let (x1, y1, x2, y2) = (rd(rec + 4) as i32, rd(rec + 8) as i32, rd(rec + 12) as i32, rd(rec + 16) as i32);
        let z = f32::from_bits(rd(rec + 20));
        let s = push(GDYN, 4 * SP_WORDS, 8);
        wr(s, rd(rec));
        for k in 1..6 {
            wr(s + 4 * k, rd(rec + 4 * k));
        }
        wr(s + 4 * SP_HAS_SPAN, 0);
        wr(s + 4 * SP_RENDER_NEXT, 0);
        let (x1f, x2f, y1f, y2f) = (x1 as f32, x2 as f32, y1 as f32, y2 as f32);
        let k = rproj_z * z;
        let (x1d, x2d) = ((x1f - fx2) * k, (x2f - fx2) * k);
        let (y1d, y2d) = ((y1f - fy2) * k, (y2f - fy2) * k);
        let corners = [(x1d, y1d, x1f, y1f), (x2d, y1d, x2f, y1f), (x2d, y2d, x2f, y2f), (x1d, y2d, x1f, y2f)];
        for (c, (px, py, sx, sy)) in corners.iter().enumerate() {
            let (a, b, cz) = (px - uo[0], py - uo[1], z - uo[2]);
            let base = s + 4 * (SP_PROXY + 5 * c as u32);
            for (n, axis) in ux.iter().enumerate() {
                wr(base + 4 * n as u32, ((a * axis[0] + b * axis[1]) + cz * axis[2]).to_bits());
            }
            wr(base + 12, sx.to_bits());
            wr(base + 16, sy.to_bits());
        }
        // FRasterPoly: [X1, X2) on each line of [Y1, Y2) (Setup checked Y1 < Y2).
        let r = new_raster(y1, y2);
        for y in y1..y2 {
            set_line(r, y - y1, x1, x2);
        }
        wr(s + 4 * 35, r);
        new_chunk(0, s, r);
    }
}

/// FDynamicChunk::Filter (0x10b23e30) for every pending chunk of a node.
fn filter_chunks(i_node: i32, outside: bool) {
    if model(16) == 0 {
        return;
    }
    let node = Node::at(i_node);
    let n = [node.plane(0), node.plane(1), node.plane(2), node.plane(3)];
    let mut c = rd(dyn_slot(i_node, 0));
    while c != 0 {
        let (s, r) = (rd(c + 4), rd(c + 8));
        let proxy = |i: usize, f: u32| rf(s + 4 * (SP_PROXY + 5 * i as u32 + f));
        let (mut front, mut back) = (0, 0);
        let mut dist = [0.0_f32; 4];
        for i in 0..4 {
            let d = ((proxy(i, 0) * n[0] + proxy(i, 2) * n[2]) + proxy(i, 1) * n[1]) - n[3];
            if d as f64 > 0.01 {
                front += 1;
            }
            dist[i] = d;
            if (d as f64) < -0.01 {
                back += 1;
            }
        }
        let (mut front_raster, mut back_raster) = (r, r);
        'split: {
            if front == 0 || back == 0 {
                break 'split;
            }
            let mut cross = [[0.0_f32; 2]; 4];
            let mut crossings = 0;
            for i in 0..4 {
                let prev = (i + 3) & 3;
                // Dist[prev]*Dist[i] < 0: opposite signs, both nonzero.
                let (a, b) = (dist[prev], dist[i]);
                if a != 0.0 && b != 0.0 && (a < 0.0) != (b < 0.0) {
                    let t = a / (a - b);
                    cross[crossings] = [
                        (proxy(i, 3) - proxy(prev, 3)) * t + proxy(prev, 3),
                        (proxy(i, 4) - proxy(prev, 4)) * t + proxy(prev, 4),
                    ];
                    crossings += 1;
                }
            }
            if crossings < 2 {
                break 'split;
            }
            let (r_start, r_end) = (rd(r) as i32, rd(r + 4) as i32);
            let lines = r_end - r_start;
            let a_raster = push(GDYN, 8 * lines.max(0) as u32 + 8, 8);
            let b_raster = push(GDYN, 8 * lines.max(0) as u32 + 8, 8);
            let (mut c0, mut c1) = (cross[0], cross[1]);
            if c0[1] > c1[1] {
                core::mem::swap(&mut c0, &mut c1);
            }
            let start_y = fistp(c0[1] - 0.5).max(r_start);
            let end_y = fistp(c1[1] - 0.5).min(r_end);
            if start_y > end_y {
                break 'split;
            }
            let top = if start_y > r_start { if dist[0] < 0.0 { b_raster } else { a_raster } } else { 0 };
            let bottom = if end_y < r_end { if dist[2] < 0.0 { b_raster } else { a_raster } } else { 0 };
            let (left, right) = if c1[0] < c0[0] {
                if dist[0] < 0.0 { (b_raster, a_raster) } else { (a_raster, b_raster) }
            } else if dist[1] < 0.0 {
                (a_raster, b_raster)
            } else {
                (b_raster, a_raster)
            };
            for raster in [a_raster, b_raster] {
                wr(raster, start_y as u32);
                wr(raster + 4, end_y as u32);
            }
            if top != 0 {
                wr(top, r_start as u32);
                for y in r_start..start_y {
                    let (x0, x1) = poly_line(r, y);
                    set_line(top, y - r_start, x0, x1);
                }
            }
            if bottom != 0 {
                wr(bottom + 4, r_end as u32);
                let b_start = rd(bottom) as i32;
                for y in end_y..r_end {
                    let (x0, x1) = poly_line(r, y);
                    set_line(bottom, y - b_start, x0, x1);
                }
            }
            if end_y != start_y {
                let slope = ((c1[0] - c0[0]) * 65536.0) / (c1[1] - c0[1]);
                let dx = trunc_i32(slope);
                let mut x = trunc_i32(((start_y as f32 + 1.0) - c0[1]) * slope + c0[0] * 65536.0);
                let (l_start, rt_start) = (rd(left) as i32, rd(right) as i32);
                for y in start_y..end_y {
                    let (x0, x1) = poly_line(r, y);
                    set_line(left, y - l_start, x0, x1);
                    set_line(right, y - rt_start, x0, x1);
                    let col = x >> 16;
                    let (lx0, lx1) = poly_line(left, y);
                    if col < lx1 {
                        set_line(left, y - l_start, lx0, col);
                    }
                    let (rx0, rx1) = poly_line(right, y);
                    if col > rx0 {
                        set_line(right, y - rt_start, col, rx1);
                    }
                    x = x.wrapping_add(dx);
                }
            }
            back_raster = if rd(b_raster + 4) as i32 <= rd(b_raster) as i32 { 0 } else { b_raster };
            front_raster = if rd(a_raster + 4) as i32 <= rd(a_raster) as i32 { 0 } else { a_raster };
        }
        let csg = node.is_csg();
        if front != 0 && front_raster != 0 {
            let child = node.child(1);
            if child != -1 {
                new_chunk(child, s, front_raster);
            } else if outside || csg {
                new_final(i_node, s, front_raster, 0);
            }
        }
        if back != 0 && back_raster != 0 {
            let child = node.child(0);
            if child != -1 {
                new_chunk(child, s, back_raster);
            } else if outside && !csg {
                new_final(i_node, s, back_raster, 1);
            }
        }
        c = rd(c);
    }
}

/// MSVC `_ftol` of a value already rounded to the register's precision.
fn trunc_i32(x: f32) -> i32 {
    if !(x > -2147483649.0 && x < 2147483648.0) {
        return i32::MIN;
    }
    x as i32
}

/// FDynamicFinalChunk::PreRender (0x10b24740) for a node side's final chunks.
fn pre_render(i_node: i32, side: u32, zone_span: &mut SpanBuffer, frame_sprite: &mut u32) {
    if model(16) == 0 {
        return;
    }
    let mut c = rd(dyn_slot(i_node, 1 + side));
    while c != 0 {
        let (s, r) = (rd(c + 4), rd(c + 8));
        let (start, end) = (rd(r) as i32, rd(r + 4) as i32);
        if rd(s + 4 * SP_HAS_SPAN) == 0 {
            let _ = push(GDYN, 0x20, 8); // the FSpanBuffer object
            let mut span = EMPTY;
            span.alloc_index(start, end, GDYN);
            if span.copy_from_raster(zone_span, start, end, false, r) {
                wr(s + 4 * SP_RENDER_NEXT, *frame_sprite);
                *frame_sprite = s;
                wr(s + 4 * SP_HAS_SPAN, 1);
                set_sprite_span(s, &span);
            } else {
                span.release();
            }
        } else {
            let mark = arena_top(GMEM);
            let _ = push(GMEM, 0x20, 8);
            let mut temp = EMPTY;
            temp.alloc_index(start, end, GMEM);
            if temp.copy_from_raster(zone_span, start, end, false, r) {
                let mut span = sprite_span(s);
                span.merge_with(&temp);
                set_sprite_span(s, &span);
            }
            set_top(GMEM, mark);
        }
        c = rd(c);
    }
}
