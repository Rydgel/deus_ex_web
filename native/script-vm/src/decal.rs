//! ADecal::execAttachDecal and execDetachDecal (Engine.dll 0x103e7250 and
//! 0x103e9a30), with the surface finder FindSurface (0x103e9090) and the
//! node gatherer GatherNodes (0x103e9340): the FDecal entries that
//! FBspSurf.Decals holds for the renderer (docs/decals.md).
//!
//! The arithmetic follows the instructions on the x87 model (x87.rs) at the
//! game thread's 64-bit precision: every `fstp dword` is an f32 store, every
//! unrounded intermediate an `Ext`, every `appSqrt` a 64-bit FSQRT of a
//! double, with the double stores where the listing has them. Sum orders are
//! per site (the inline normalizations differ). Core's vector operators
//! (operator-, +, *, |, Normalize, UnsafeNormal, SizeSquared) are single x87
//! operations with an f32 store per component.
//!
//! Model block (decal-kernel.mjs `uploadDecalModel`), u32 words:
//!   header: node count, nodes, verts, points, vectors, surfs, surf-node
//!     lists (byte addresses), the trace model (trace.rs layout), surf count,
//!     vert count, point count, vector count, surf-node count;
//!   node: iVertPool, iSurf, iPlane (the coplanar link), NumVertices;
//!   vert: pVertex; point and vector: three f32 bit patterns;
//!   surf: PolyFlags, pBase, vNormal, Nodes start, Nodes count, Actor is a
//!     Mover (1) — Surf.Nodes as UModel::PostLoad builds it (0x103ace90:
//!     ascending node index).
//!
//! Store block (one per loaded level, `decal_store_init`): a header, each
//! surface's FDecal list as a doubly linked list of records (head, tail),
//! and the records: links, surface, Actor, Vertices[4], MoverRotation and
//! Nodes. A list's order is the TArray order the original keeps.

use crate::trace;
use crate::x87::Ext;
use core::ptr::{addr_of, addr_of_mut};

#[link(wasm_import_module = "env")]
extern "C" {
    /// msvcrt rand() of the shared stream (Core appFrand's call).
    fn decal_rand() -> i32;
    /// A decal actor's live Texture (AActor +0x16c) as the host's object id.
    fn decal_texture(actor: u32) -> u32;
}

/// Attach and detach in/out words. Inputs: [0] actor, [1..4] Location bits,
/// [4..7] Rotation, [7] TraceDistance bits, [8..11] DecalDir bits,
/// [11] DrawScale bits, [12] Texture.USize, [13] MultiDecalLevel (after the
/// clamp at 0x103e7351), [14] Texture id, [15] SurfList count, [64..128]
/// SurfList. Outputs: [32] result, [33] exit, [34] appended count,
/// [35..52] appended surfaces, [52] rand() calls, [53] fault code.
static mut IO: [u32; 128] = [0; 128];

#[no_mangle]
pub extern "C" fn decal_io_ptr() -> *mut u32 {
    addr_of_mut!(IO) as *mut u32
}

pub const OK: u32 = 0;
/// Fewer free records than one attach can use; nothing was changed.
pub const FULL: u32 = 1;
/// A fault, with its code in IO[53]; the store may be partly updated.
pub const FAULT: u32 = 2;

const FAULT_MODEL: u32 = 1;
const FAULT_TRACE: u32 = 2;
const FAULT_CLIP_ASSERT: u32 = 3;
const FAULT_NODES: u32 = 4;
const FAULT_SURFLIST: u32 = 5;
const FAULT_MOVER: u32 = 6;
const FAULT_STORE: u32 = 7;

pub const EXIT_ATTACHED: u32 = 0;
pub const EXIT_TRACE_MISS: u32 = 1;
pub const EXIT_NO_ITEM: u32 = 2;
pub const EXIT_NO_SURFACE: u32 = 3;
pub const EXIT_ROTATION_PARALLEL: u32 = 4;
pub const EXIT_OFF_PLANE: u32 = 5;
pub const EXIT_POLY_FLAGS: u32 = 6;

/// Record words: prev, next, surface, actor, Vertices (12), MoverRotation
/// (3), node count, nodes.
pub const REC: usize = 84;
const MAX_NODES: usize = 64;
const HEADER: usize = 16;
const SURFLIST_MAX: usize = 64;

type V = [u32; 3];

fn io(i: usize) -> u32 {
    unsafe { (*addr_of!(IO))[i] }
}
fn set_io(i: usize, v: u32) {
    unsafe { (*addr_of_mut!(IO))[i] = v }
}

#[inline(always)]
unsafe fn word(addr: u32) -> u32 {
    *(addr as usize as *const u32)
}
#[inline(always)]
unsafe fn set_word(addr: u32, v: u32) {
    *(addr as usize as *mut u32) = v
}

// ---- the model -----------------------------------------------------------

struct Model {
    nodes: u32,
    node_count: u32,
    verts: u32,
    vert_count: u32,
    points: u32,
    point_count: u32,
    vectors: u32,
    vector_count: u32,
    surfs: u32,
    surf_count: u32,
    surf_nodes: u32,
    surf_node_count: u32,
    trace: u32,
}

struct Node {
    pool: u32,
    surf: u32,
    plane: i32,
    count: u32,
}

struct Surf {
    flags: u32,
    base: u32,
    normal: u32,
    nodes: u32,
    node_count: u32,
    mover: bool,
}

impl Model {
    unsafe fn load(at: u32) -> Model {
        let h = |i: u32| word(at + 4 * i);
        Model {
            node_count: h(0),
            nodes: h(1),
            verts: h(2),
            points: h(3),
            vectors: h(4),
            surfs: h(5),
            surf_nodes: h(6),
            trace: h(7),
            surf_count: h(8),
            vert_count: h(9),
            point_count: h(10),
            vector_count: h(11),
            surf_node_count: h(12),
        }
    }
    unsafe fn node(&self, i: i32) -> Result<Node, u32> {
        if i < 0 || i as u32 >= self.node_count {
            return Err(FAULT_MODEL);
        }
        let at = self.nodes + 16 * i as u32;
        Ok(Node { pool: word(at), surf: word(at + 4), plane: word(at + 8) as i32, count: word(at + 12) })
    }
    unsafe fn surf(&self, i: u32) -> Result<Surf, u32> {
        if i >= self.surf_count {
            return Err(FAULT_MODEL);
        }
        let at = self.surfs + 24 * i;
        Ok(Surf {
            flags: word(at),
            base: word(at + 4),
            normal: word(at + 8),
            nodes: word(at + 12),
            node_count: word(at + 16),
            mover: word(at + 20) != 0,
        })
    }
    unsafe fn point(&self, i: u32) -> Result<V, u32> {
        if i >= self.point_count {
            return Err(FAULT_MODEL);
        }
        let at = self.points + 12 * i;
        Ok([word(at), word(at + 4), word(at + 8)])
    }
    unsafe fn vector(&self, i: u32) -> Result<V, u32> {
        if i >= self.vector_count {
            return Err(FAULT_MODEL);
        }
        let at = self.vectors + 12 * i;
        Ok([word(at), word(at + 4), word(at + 8)])
    }
    /// Points[Verts[i].pVertex].
    unsafe fn vert_point(&self, i: u32) -> Result<V, u32> {
        if i >= self.vert_count {
            return Err(FAULT_MODEL);
        }
        self.point(word(self.verts + 4 * i))
    }
    unsafe fn surf_node(&self, i: u32) -> Result<i32, u32> {
        if i >= self.surf_node_count {
            return Err(FAULT_MODEL);
        }
        Ok(word(self.surf_nodes + 4 * i) as i32)
    }
    /// UModel::LineCheck (vtable +0x58, 0x103f3c20) with no owner, a zero
    /// extent and ExtraNodeFlags 6: the hit node (Hit.Item), None on a miss.
    unsafe fn line_check(&self, end: V, start: V) -> Result<Option<i32>, u32> {
        let f = |b: u32| f32::from_bits(b) as f64;
        match trace::ray_hit(self.trace, [f(start[0]), f(start[1]), f(start[2])], [f(end[0]), f(end[1]), f(end[2])], 6, false) {
            Ok(Some(hit)) => Ok(Some(hit.node as i32)),
            Ok(None) => Ok(None),
            Err(()) => Err(FAULT_TRACE),
        }
    }
}

// ---- x87 helpers -----------------------------------------------------------

#[inline(always)]
fn ld(b: u32) -> Ext {
    Ext::load(b)
}
#[inline(always)]
fn sub(a: Ext, b: Ext) -> Ext {
    a.add(b.neg())
}
fn one() -> Ext {
    Ext::load_f64(1.0)
}
/// Core operator- (0x10117780): this - arg, per component.
fn vsub(a: V, b: V) -> V {
    [sub(ld(a[0]), ld(b[0])).store(), sub(ld(a[1]), ld(b[1])).store(), sub(ld(a[2]), ld(b[2])).store()]
}
/// Core operator+ (0x10117740) and the inline adds: one rounded add each.
fn vadd(a: V, b: V) -> V {
    [ld(a[0]).add(ld(b[0])).store(), ld(a[1]).add(ld(b[1])).store(), ld(a[2]).add(ld(b[2])).store()]
}
/// Core operator*(float) (0x101177c0) and Engine operator*(float, FVector)
/// (0x103d7cb0): one rounded product each.
fn vscale(a: V, s: u32) -> V {
    [ld(s).mul(ld(a[0])).store(), ld(s).mul(ld(a[1])).store(), ld(s).mul(ld(a[2])).store()]
}
/// Core operator| (0x10117710): (arg.z*this.z + arg.y*this.y) + arg.x*this.x.
fn vdot(this: V, arg: V) -> Ext {
    ld(arg[2]).mul(ld(this[2])).add(ld(arg[1]).mul(ld(this[1]))).add(ld(arg[0]).mul(ld(this[0])))
}
fn sq(a: u32) -> Ext {
    ld(a).mul(ld(a))
}
/// (x*x + y*y) + z*z: SizeSquared (0x10117b70) and the inline normalizes.
fn size_sq(v: V) -> Ext {
    sq(v[0]).add(sq(v[1])).add(sq(v[2]))
}
/// appSqrt (Core 0x10123290): FSQRT of the double argument.
fn app_sqrt(s: Ext) -> Ext {
    s.store_double().sqrt()
}
/// The inline normalize: `fst qword s; fcomp 1e-8`; then
/// `1.0 / double(appSqrt(double s))` and an f32 product per component.
fn norm_inline(v: V, s: Ext) -> V {
    if s.below_1em8() {
        return v;
    }
    let inv = one().div(app_sqrt(s).store_double());
    [inv.mul(ld(v[0])).store(), inv.mul(ld(v[1])).store(), inv.mul(ld(v[2])).store()]
}
/// Core FVector::Normalize (0x10117cf0): the sqrt stays unrounded.
fn core_normalize(v: V) -> V {
    let s = size_sq(v);
    if s.below_1em8() {
        return v;
    }
    let inv = one().div(app_sqrt(s));
    [inv.mul(ld(v[0])).store(), inv.mul(ld(v[1])).store(), inv.mul(ld(v[2])).store()]
}
/// Core FVector::UnsafeNormal (0x10117dd0): no threshold.
fn unsafe_normal(v: V) -> V {
    let inv = one().div(app_sqrt(size_sq(v)));
    [inv.mul(ld(v[0])).store(), inv.mul(ld(v[1])).store(), inv.mul(ld(v[2])).store()]
}
/// FCOM/FCOMP's C0 (below or unordered) and C3 (equal or unordered).
fn below(a: Ext, b: Ext) -> bool {
    a.compare(b).0
}
fn equal_or_unordered(a: Ext, b: Ext) -> bool {
    a.compare(b).1
}
/// `test ah, 0x41; je` taken: strictly greater and ordered.
fn above(a: Ext, b: Ext) -> bool {
    let (c0, c3) = a.compare(b);
    !c0 && !c3
}
/// `fcom 0; test ah, 1; je; fchs`: the absolute value as the code takes it.
fn fabs_x87(a: Ext) -> Ext {
    if below(a, Ext::zero(0)) {
        a.neg_raw()
    } else {
        a
    }
}

trait NegRaw {
    fn neg_raw(self) -> Self;
}
impl NegRaw for Ext {
    /// FCHS: flips the sign, a NaN's too.
    fn neg_raw(mut self) -> Self {
        self.sign ^= 0x8000_0000;
        if self.special != 0 {
            self.special ^= 0x8000_0000;
        }
        self
    }
}

/// The probe of 0x103e764c and the grid: the segment start + (end - start)
/// scaled to the plane through `base` with normal `n`.
fn plane_probe(start: V, end: V, base: V, n: V) -> V {
    let a = vdot(vsub(base, start), n).store();
    let b = vdot(vsub(end, start), n).store();
    let t = ld(a).div(ld(b)).store();
    vadd(vscale(vsub(end, start), t), start)
}

// ---- FindSurface (0x103e9090) -----------------------------------------------

unsafe fn find_surface(m: &Model, mut node: i32, p: V) -> Result<i32, u32> {
    let mut guard = 0u32;
    'chain: loop {
        if node == -1 {
            return Ok(-1);
        }
        guard += 1;
        if guard > m.node_count + 1 {
            return Err(FAULT_MODEL);
        }
        let nd = m.node(node)?;
        if nd.count == 0 {
            node = nd.plane;
            continue;
        }
        let n = m.vector(m.surf(nd.surf)?.normal)?;
        let mut prev = m.vert_point(nd.pool + nd.count - 1)?;
        let mut prev_side = Ext::zero(0);
        for k in 0..nd.count {
            let cur = m.vert_point(nd.pool + k)?;
            let ez = sub(ld(cur[2]), ld(prev[2]));
            let ey = sub(ld(cur[1]), ld(prev[1]));
            let ex = sub(ld(cur[0]), ld(prev[0]));
            let cz = sub(ey.mul(ld(n[0])), ex.mul(ld(n[1]))).store();
            let cy = sub(ex.mul(ld(n[2])), ez.mul(ld(n[0]))).store();
            let cx = sub(ez.mul(ld(n[1])), ey.mul(ld(n[2])));
            let d1 = ld(cur[1]).mul(ld(cy)).add(ld(cur[2]).mul(ld(cz))).add(ld(cur[0]).mul(cx));
            let d2 = ld(p[1]).mul(ld(cy)).add(ld(p[2]).mul(ld(cz))).add(ld(p[0]).mul(cx));
            let side = sub(d2, d1);
            let zero = Ext::zero(0);
            if below(side, zero) && above(prev_side, zero) {
                node = nd.plane;
                continue 'chain;
            }
            if above(side, zero) && below(prev_side, zero) {
                node = nd.plane;
                continue 'chain;
            }
            prev_side = side.stored();
            prev = cur;
        }
        return Ok(nd.surf as i32);
    }
}

// ---- GatherNodes (0x103e9340) -----------------------------------------------

/// The FBspNode indices of `surf` whose polygon keeps part of the quad
/// `verts` (world space): Sutherland–Hodgman against each polygon edge,
/// keeping distances >= 0, in the static 24-point buffer.
unsafe fn gather_nodes(m: &Model, surf: &Surf, verts: &[V; 4], out: &mut [u32; MAX_NODES]) -> Result<usize, u32> {
    let n = m.vector(surf.normal)?;
    let mut found = 0usize;
    for i in 0..surf.node_count {
        let index = m.surf_node(surf.nodes + i)?;
        let nd = m.node(index)?;
        if nd.count == 0 {
            continue;
        }
        let mut buf: [V; 25] = [[0; 3]; 25];
        let mut dist: [u32; 25] = [0; 25];
        buf[..4].copy_from_slice(verts);
        let mut count = 4usize;
        let mut prev = m.vert_point(nd.pool + nd.count - 1)?;
        let mut rejected = false;
        for k in 0..nd.count {
            let cur = m.vert_point(nd.pool + k)?;
            let ez = sub(ld(cur[2]), ld(prev[2]));
            let ey = sub(ld(cur[1]), ld(prev[1]));
            let ex = sub(ld(cur[0]), ld(prev[0]));
            let cz = sub(ey.mul(ld(n[0])), ex.mul(ld(n[1]))).store();
            let cy = sub(ex.mul(ld(n[2])), ez.mul(ld(n[0]))).store();
            let cx = sub(ez.mul(ld(n[1])), ey.mul(ld(n[2])));
            let cxf = cx.store();
            let w = ld(cur[1]).mul(ld(cy)).add(ld(cur[2]).mul(ld(cz))).add(ld(cur[0]).mul(cx)).store();
            let plane = |p: V| ld(cz).mul(ld(p[2])).add(ld(cy).mul(ld(p[1]))).add(ld(cxf).mul(ld(p[0])));
            for j in 0..count {
                dist[j] = sub(plane(buf[j]), ld(w)).store();
            }
            let zero = Ext::zero(0);
            let mut j = 0usize;
            while j < count {
                let nx = (j + 1) % count;
                let crossing = if !above(ld(dist[j]), zero) {
                    below(ld(dist[j]), zero) && above(ld(dist[nx]), zero)
                } else {
                    below(ld(dist[nx]), zero) || (below(ld(dist[j]), zero) && above(ld(dist[nx]), zero))
                };
                if crossing {
                    let a = buf[j];
                    let b = buf[nx];
                    let dz = sub(ld(b[2]), ld(a[2]));
                    let dzf = dz.store();
                    let dy = sub(ld(b[1]), ld(a[1])).store();
                    let dx = sub(ld(b[0]), ld(a[0])).store();
                    let num = sub(ld(w), plane(a));
                    let den = ld(cy).mul(ld(dy)).add(ld(cz).mul(ld(dzf))).add(ld(dx).mul(ld(cxf)));
                    let t = num.div(den).store();
                    let step = [ld(dx).mul(ld(t)).store(), ld(dy).mul(ld(t)).store(), dz.mul(ld(t)).store()];
                    let fresh = vadd(step, a);
                    let mut s = count;
                    while s > j + 1 {
                        buf[s] = buf[s - 1];
                        dist[s] = dist[s - 1];
                        s -= 1;
                    }
                    buf[j + 1] = fresh;
                    dist[j + 1] = 0;
                    count += 1;
                    if count >= 24 {
                        return Err(FAULT_CLIP_ASSERT);
                    }
                    j += 1;
                }
                j += 1;
            }
            let mut j = 0usize;
            while j < count {
                if below(ld(dist[j]), zero) {
                    for s in j..count - 1 {
                        buf[s] = buf[s + 1];
                        dist[s] = dist[s + 1];
                    }
                    count -= 1;
                } else {
                    j += 1;
                }
            }
            if count == 0 {
                rejected = true;
                break;
            }
            prev = cur;
        }
        if !rejected {
            if found == MAX_NODES {
                return Err(FAULT_NODES);
            }
            out[found] = index as u32;
            found += 1;
        }
    }
    Ok(found)
}

// ---- the store ---------------------------------------------------------------

struct Store {
    at: u32,
}

impl Store {
    unsafe fn capacity(&self) -> u32 {
        word(self.at)
    }
    unsafe fn free_head(&self) -> i32 {
        word(self.at + 4) as i32
    }
    unsafe fn set_free_head(&self, v: i32) {
        set_word(self.at + 4, v as u32)
    }
    unsafe fn surf_count(&self) -> u32 {
        word(self.at + 8)
    }
    unsafe fn used(&self) -> u32 {
        word(self.at + 12)
    }
    unsafe fn set_used(&self, v: u32) {
        set_word(self.at + 12, v)
    }
    unsafe fn surf_at(&self, s: u32) -> u32 {
        self.at + 4 * HEADER as u32 + 8 * s
    }
    unsafe fn rec(&self, r: i32) -> u32 {
        self.at + 4 * HEADER as u32 + 8 * self.surf_count() + 4 * REC as u32 * r as u32
    }
    unsafe fn head(&self, s: u32) -> i32 {
        word(self.surf_at(s)) as i32
    }
    unsafe fn next(&self, r: i32) -> i32 {
        word(self.rec(r) + 4) as i32
    }
    unsafe fn actor(&self, r: i32) -> u32 {
        word(self.rec(r) + 12)
    }
    /// A zeroed record linked before `before` (or at the tail) of `s`.
    unsafe fn insert(&self, s: u32, before: i32) -> Result<i32, u32> {
        let r = self.free_head();
        if r < 0 {
            return Err(FAULT_STORE);
        }
        let at = self.rec(r);
        self.set_free_head(word(at + 4) as i32);
        for k in 0..REC as u32 {
            set_word(at + 4 * k, 0);
        }
        set_word(at + 8, s);
        let sa = self.surf_at(s);
        let (prev, next) = if before < 0 {
            (word(sa + 4) as i32, -1)
        } else {
            (word(self.rec(before)) as i32, before)
        };
        set_word(at, prev as u32);
        set_word(at + 4, next as u32);
        if prev < 0 {
            set_word(sa, r as u32);
        } else {
            set_word(self.rec(prev) + 4, r as u32);
        }
        if next < 0 {
            set_word(sa + 4, r as u32);
        } else {
            set_word(self.rec(next), r as u32);
        }
        self.set_used(self.used() + 1);
        Ok(r)
    }
    unsafe fn remove(&self, r: i32) {
        let at = self.rec(r);
        let (prev, next, s) = (word(at) as i32, word(at + 4) as i32, word(at + 8));
        let sa = self.surf_at(s);
        if prev < 0 {
            set_word(sa, next as u32);
        } else {
            set_word(self.rec(prev) + 4, next as u32);
        }
        if next < 0 {
            set_word(sa + 4, prev as u32);
        } else {
            set_word(self.rec(next), prev as u32);
        }
        set_word(at + 4, self.free_head() as u32);
        set_word(at + 8, u32::MAX);
        self.set_free_head(r);
        self.set_used(self.used() - 1);
    }
    /// InsertDecal (0x103e7922, 0x103e851f): before the first entry whose
    /// Actor's Texture is `texture`, else appended.
    unsafe fn insert_decal(&self, s: u32, actor: u32, texture: u32) -> Result<i32, u32> {
        let mut k = self.head(s);
        while k >= 0 {
            if decal_texture(self.actor(k)) == texture {
                break;
            }
            k = self.next(k);
        }
        let r = self.insert(s, k)?;
        set_word(self.rec(r) + 12, actor);
        Ok(r)
    }
    #[allow(dead_code)]
    unsafe fn vertices(&self, r: i32) -> [V; 4] {
        let at = self.rec(r) + 16;
        let mut v = [[0u32; 3]; 4];
        for k in 0..4 {
            for c in 0..3 {
                v[k][c] = word(at + 4 * (3 * k + c) as u32);
            }
        }
        v
    }
    unsafe fn set_vertices(&self, r: i32, v: &[V; 4]) {
        let at = self.rec(r) + 16;
        for k in 0..4 {
            for c in 0..3 {
                set_word(at + 4 * (3 * k + c) as u32, v[k][c]);
            }
        }
    }
    unsafe fn set_nodes(&self, r: i32, nodes: &[u32]) {
        let at = self.rec(r) + 76;
        set_word(at, nodes.len() as u32);
        for (k, n) in nodes.iter().enumerate() {
            set_word(at + 4 + 4 * k as u32, *n);
        }
    }
}

/// Bytes of a store for `surf_count` surfaces and `capacity` records.
#[no_mangle]
pub extern "C" fn decal_store_size(surf_count: u32, capacity: u32) -> u32 {
    4 * (HEADER as u32 + 2 * surf_count + REC as u32 * capacity)
}
#[no_mangle]
pub extern "C" fn decal_record_words() -> u32 {
    REC as u32
}

/// An empty store: every surface list empty, every record free.
#[no_mangle]
pub extern "C" fn decal_store_init(at: u32, surf_count: u32, capacity: u32) {
    unsafe {
        for k in 0..HEADER as u32 {
            set_word(at + 4 * k, 0);
        }
        set_word(at, capacity);
        set_word(at + 8, surf_count);
        let st = Store { at };
        for s in 0..surf_count {
            set_word(st.surf_at(s), u32::MAX);
            set_word(st.surf_at(s) + 4, u32::MAX);
        }
        for r in 0..capacity {
            let rec = st.rec(r as i32);
            set_word(rec, u32::MAX);
            set_word(rec + 4, if r + 1 < capacity { r + 1 } else { u32::MAX });
            set_word(rec + 8, u32::MAX);
        }
        st.set_free_head(if capacity > 0 { 0 } else { -1 });
    }
}

/// Copy `from` into the larger `to` (same surface count), whose extra
/// records join the free list.
#[no_mangle]
pub extern "C" fn decal_store_grow(from: u32, to: u32, capacity: u32) {
    unsafe {
        let old = Store { at: from };
        let old_capacity = old.capacity();
        let words = HEADER as u32 + 2 * old.surf_count() + REC as u32 * old_capacity;
        for k in 0..words {
            set_word(to + 4 * k, word(from + 4 * k));
        }
        set_word(to, capacity);
        let st = Store { at: to };
        for r in old_capacity..capacity {
            let rec = st.rec(r as i32);
            set_word(rec, u32::MAX);
            set_word(rec + 4, if r + 1 < capacity { r + 1 } else { old.free_head() as u32 });
            set_word(rec + 8, u32::MAX);
        }
        if capacity > old_capacity {
            st.set_free_head(old_capacity as i32);
        }
    }
}

// ---- execAttachDecal (0x103e7250) ---------------------------------------------

#[no_mangle]
pub extern "C" fn decal_attach(model: u32, store: u32) -> u32 {
    for k in 32..64 {
        set_io(k, 0);
    }
    let st = Store { at: store };
    let level = io(13) as i32;
    let cells = if level > 0 { (level * level) as u32 } else { 0 };
    unsafe {
        if st.capacity() - st.used() < 1 + cells {
            return FULL;
        }
        if io(15) as usize > SURFLIST_MAX {
            set_io(53, FAULT_SURFLIST);
            return FAULT;
        }
        match attach(&Model::load(model), &st) {
            Ok(()) => OK,
            Err(code) => {
                set_io(53, code);
                FAULT
            }
        }
    }
}

fn finish(result: u32, exit: u32) -> Result<(), u32> {
    set_io(32, result);
    set_io(33, exit);
    Ok(())
}

unsafe fn surf_list_has(s: u32) -> bool {
    let count = io(15) as usize;
    (0..count).any(|k| io(64 + k) == s) || (0..io(34) as usize).any(|k| io(35 + k) == s)
}
unsafe fn surf_list_add(s: u32) -> Result<(), u32> {
    let n = io(34) as usize;
    if io(15) as usize + n >= SURFLIST_MAX || n >= 17 {
        return Err(FAULT_SURFLIST);
    }
    set_io(35 + n, s);
    set_io(34, n as u32 + 1);
    Ok(())
}

unsafe fn rand_frand() -> Ext {
    set_io(52, io(52) + 1);
    // appFrand (Core 0x101232e0): fild rand(); fmul 1/32767f.
    Ext::load_i32(decal_rand()).mul(ld(0x3800_0100))
}

unsafe fn attach(m: &Model, st: &Store) -> Result<(), u32> {
    let actor = io(0);
    let loc: V = [io(1), io(2), io(3)];
    let rotation = [io(4) as i32, io(5) as i32, io(6) as i32];
    let trace_distance = io(7);
    let mut dir: V = [io(8), io(9), io(10)];
    let draw_scale = io(11);
    let usize = io(12) as i32;
    let level = io(13) as i32;
    let texture = io(14);
    let zero = Ext::zero(0);

    // 0x103e73f1: V = normalize(-XAxis) * TraceDistance.
    let coords = crate::percep::fcoords_axes(rotation);
    let bits = |v: f64| (v as f32).to_bits();
    let x_axis: V = [bits(coords[1][0]), bits(coords[1][1]), bits(coords[1][2])];
    let minus = ld(0xbf80_0000);
    let mut v: V = [ld(x_axis[0]).mul(minus).store(), ld(x_axis[1]).mul(minus).store(), ld(x_axis[2]).mul(minus).store()];
    let s = sq(v[2]).add(sq(v[1])).add(sq(v[0]));
    v = norm_inline(v, s);
    v = [ld(v[0]).mul(ld(trace_distance)).store(), ld(v[1]).mul(ld(trace_distance)).store(), ld(v[2]).mul(ld(trace_distance)).store()];

    // 0x103e74c1: a zero DecalDir draws a random unit direction.
    let random = equal_or_unordered(ld(dir[0]), zero) && equal_or_unordered(ld(dir[1]), zero) && equal_or_unordered(ld(dir[2]), zero);
    if random {
        let one_f = ld(0x3f80_0000);
        loop {
            let mut r = [0u32; 3];
            for c in 0..3 {
                let f = rand_frand();
                r[c] = sub(f.add(f), one_f).store();
            }
            if !above(size_sq(r), one()) {
                dir = unsafe_normal(r);
                break;
            }
        }
    }

    // 0x103e7587: the trace from Location.
    let end = vadd(v, loc);
    let item = match m.line_check(end, loc)? {
        None => return finish(0, EXIT_TRACE_MISS),
        Some(item) => item,
    };
    if item == -1 {
        return finish(0, EXIT_NO_ITEM);
    }
    let s0 = m.surf(m.node(item)?.surf)?;
    let p1 = plane_probe(loc, end, m.point(s0.base)?, m.vector(s0.normal)?);
    let i_surf = find_surface(m, item, p1)?;
    if i_surf == -1 {
        return finish(0, EXIT_NO_SURFACE);
    }
    let i_surf = i_surf as u32;
    let surf = m.surf(i_surf)?;
    let n = m.vector(surf.normal)?;
    let base = m.point(surf.base)?;
    let p2 = plane_probe(loc, end, base, n);

    // 0x103e787d: the recomputed coords; the X axis must not lie in the plane.
    let along = ld(x_axis[1]).mul(ld(n[1])).add(ld(x_axis[2]).mul(ld(n[2]))).add(ld(x_axis[0]).mul(ld(n[0])));
    if equal_or_unordered(along, zero) {
        return finish(0, EXIT_ROTATION_PARALLEL);
    }
    let dv = vsub(base, p2);
    let dist = ld(dv[0]).mul(ld(n[0])).add(ld(dv[2]).mul(ld(n[2]))).add(ld(dv[1]).mul(ld(n[1])));
    if above(fabs_x87(dist), ld(0x3a83_126f)) {
        return finish(0, EXIT_OFF_PLANE);
    }
    if surf.flags & 0x600 != 0 {
        return finish(0, EXIT_POLY_FLAGS);
    }

    // 0x103e7922: the entry, SurfList, the mover branch.
    let e = st.insert_decal(i_surf, actor, texture)?;
    surf_list_add(i_surf)?;
    if surf.mover {
        // MoverRotation and AActor::SetBase(Owner, 1): no shipped level
        // surface belongs to a Mover (docs/decals.md), so this stays a
        // labelled boundary.
        return Err(FAULT_MOVER);
    }

    // 0x103e7a03: the quad radius; VSize is not read.
    let u = Ext::load_i32(usize);
    let r2 = ld(draw_scale).mul(ld(draw_scale)).mul(u).mul(u).mul(ld(0x3f00_0000));
    let radius = app_sqrt(r2).store();

    let mut v0: V;
    let mut v1: V;
    let explicit = if !random {
        let d = ld(dir[2]).mul(ld(n[2])).add(ld(dir[1]).mul(ld(n[1]))).add(ld(dir[0]).mul(ld(n[0])));
        let tz = d.mul(ld(n[2])).store();
        let ty = d.mul(ld(n[1])).store();
        let tx = d.mul(ld(n[0]));
        let p: V = [sub(ld(dir[0]), tx).store(), sub(ld(dir[1]), ld(ty)).store(), sub(ld(dir[2]), ld(tz)).store()];
        let small = |c: u32| below(fabs_x87(ld(c)), Ext::load_f64(0.0001));
        if small(p[0]) && small(p[1]) && small(p[2]) {
            dir = vsub(base, p2);
            None
        } else {
            Some(p)
        }
    } else {
        None
    };
    match explicit {
        Some(p) => {
            // 0x103e82f6: W = P x N; normalized P and W give the diagonals.
            let w: V = [
                sub(ld(p[1]).mul(ld(n[2])), ld(p[2]).mul(ld(n[1]))).store(),
                sub(ld(p[2]).mul(ld(n[0])), ld(p[0]).mul(ld(n[2]))).store(),
                sub(ld(p[0]).mul(ld(n[1])), ld(p[1]).mul(ld(n[0]))).store(),
            ];
            let pn = norm_inline(p, size_sq(p));
            let wn = norm_inline(w, sq(w[0]).add(sq(w[2])).add(sq(w[1])));
            v0 = vadd(wn, pn);
            v1 = vsub(pn, wn);
        }
        None => {
            // 0x103e7b59: U0 = D projected on the plane, U1 = U0 x N.
            let d = ld(dir[2]).mul(ld(n[2])).add(ld(dir[1]).mul(ld(n[1]))).add(ld(dir[0]).mul(ld(n[0])));
            let t: V = [d.mul(ld(n[0])).store(), d.mul(ld(n[1])).store(), d.mul(ld(n[2])).store()];
            v0 = vsub(dir, t);
            v1 = [
                sub(ld(v0[1]).mul(ld(n[2])), ld(v0[2]).mul(ld(n[1]))).store(),
                sub(ld(v0[2]).mul(ld(n[0])), ld(v0[0]).mul(ld(n[2]))).store(),
                sub(ld(v0[0]).mul(ld(n[1])), ld(v0[1]).mul(ld(n[0]))).store(),
            ];
        }
    }
    // 0x103e7c2f: normalize, scale by the radius, mirror, offset by P2.
    v0 = norm_inline(v0, size_sq(v0));
    v1 = norm_inline(v1, size_sq(v1));
    v0 = vscale(v0, radius);
    v1 = vscale(v1, radius);
    let neg = |a: V| [a[0] ^ 0x8000_0000, a[1] ^ 0x8000_0000, a[2] ^ 0x8000_0000];
    let quad: [V; 4] = [vadd(p2, v0), vadd(p2, v1), vadd(p2, neg(v0)), vadd(p2, neg(v1))];
    st.set_vertices(e, &quad);
    let mut nodes = [0u32; MAX_NODES];
    let count = gather_nodes(m, &surf, &quad, &mut nodes)?;
    st.set_nodes(e, &nodes[..count]);

    // 0x103e7e37: the footprint grid, traced 16 units either side along the
    // unit normal.
    let inv = one().div(app_sqrt(size_sq(n)));
    let nn: V = [inv.mul(ld(n[0])).store(), inv.mul(ld(n[1])).store(), inv.mul(ld(n[2])).store()];
    let off = vscale(nn, 0xc180_0000);
    let e1 = vsub(quad[1], quad[0]);
    let e2 = vsub(quad[3], quad[0]);
    let len_n = app_sqrt(size_sq(n)).store();
    for i in 0..level.max(0) {
        for j in 0..level {
            let tj = Ext::load_i32(j).add(one()).div(Ext::load_i32(level));
            let a = [ld(e2[0]).mul(tj).store(), ld(e2[1]).mul(tj).store(), ld(e2[2]).mul(tj).store()];
            let ti = Ext::load_i32(i).add(one()).div(Ext::load_i32(level));
            let b = [ld(e1[0]).mul(ti).store(), ld(e1[1]).mul(ti).store(), ld(e1[2]).mul(ti).store()];
            let c = vadd(b, quad[0]);
            let sample = vadd(a, c);
            let start = vsub(sample, off);
            let end = vadd(sample, off);
            let item = match m.line_check(end, start)? {
                None => continue,
                Some(item) => item,
            };
            if item == -1 {
                continue;
            }
            let hit = m.surf(m.node(item)?.surf)?;
            let q = plane_probe(start, end, m.point(hit.base)?, m.vector(hit.normal)?);
            let s2 = find_surface(m, item, q)?;
            if s2 == -1 {
                continue;
            }
            let s2 = s2 as u32;
            if surf_list_has(s2) {
                continue;
            }
            let surf2 = m.surf(s2)?;
            if surf2.flags & 0x600 != 0 {
                continue;
            }
            let n2 = m.vector(surf2.normal)?;
            let base2 = m.point(surf2.base)?;
            let len_n2 = app_sqrt(size_sq(n2));
            let dot = ld(n2[2]).mul(ld(n[2])).add(ld(n2[1]).mul(ld(n[1]))).add(ld(n2[0]).mul(ld(n[0])));
            let cos = dot.div(ld(len_n).mul(len_n2));
            let cosf = cos.store();
            if !above(fabs_x87(cos), Ext::load_f64(0.7)) {
                continue;
            }
            let e2r = st.insert_decal(s2, actor, texture)?;
            surf_list_add(s2)?;
            let mut moved = [[0u32; 3]; 4];
            for k in 0..4 {
                let vk = quad[k];
                let t1 = vsub(vk, n);
                let q1 = plane_probe(t1, vk, base2, n2);
                let t2 = vsub(vk, n2);
                let q2 = plane_probe(t2, vk, base2, n2);
                let da_v = vsub(vk, q2);
                let da = app_sqrt(sq(da_v[2]).add(sq(da_v[1])).add(sq(da_v[0]))).div(ld(cosf)).store();
                let db_v = vsub(vk, q1);
                let db = app_sqrt(sq(db_v[2]).add(sq(db_v[1])).add(sq(db_v[0]))).div(ld(cosf)).store();
                let along = core_normalize(vsub(q2, q1));
                let shift = sub(ld(db), ld(da)).store();
                moved[k] = vsub(q2, vscale(along, shift));
            }
            st.set_vertices(e2r, &moved);
            let count = gather_nodes(m, &surf2, &moved, &mut nodes)?;
            st.set_nodes(e2r, &nodes[..count]);
            let relative = [vsub(moved[0], base2), vsub(moved[1], base2), vsub(moved[2], base2), vsub(moved[3], base2)];
            st.set_vertices(e2r, &relative);
        }
    }
    // 0x103e8915: the first entry's vertices relative to its base.
    let relative = [vsub(quad[0], base), vsub(quad[1], base), vsub(quad[2], base), vsub(quad[3], base)];
    st.set_vertices(e, &relative);
    finish(1, EXIT_ATTACHED)
}

// ---- execDetachDecal (0x103e9a30) ---------------------------------------------

/// IO[0] actor, IO[15] SurfList count, IO[64..] SurfList: from the last
/// entry, the first FDecal of that surface whose Actor is this is removed.
#[no_mangle]
pub extern "C" fn decal_detach(store: u32) -> u32 {
    let st = Store { at: store };
    let actor = io(0);
    let count = io(15) as usize;
    if count > SURFLIST_MAX {
        set_io(53, FAULT_SURFLIST);
        return FAULT;
    }
    unsafe {
        for k in (0..count).rev() {
            let s = io(64 + k);
            if s >= st.surf_count() {
                set_io(53, FAULT_MODEL);
                return FAULT;
            }
            let mut r = st.head(s);
            while r >= 0 {
                if st.actor(r) == actor {
                    st.remove(r);
                    break;
                }
                r = st.next(r);
            }
        }
    }
    OK
}

// ---- URender::DrawFrame's decal block and ClipDecal --------------------------
//
// DrawFrame (Render.dll 0x10b1b0ca-0x10b1b34d) draws a surface's decals after
// its DrawComplexSurface: for each FDecal in TArray order, each saved polygon
// of the draw item whose node is in the decal's Nodes (all when Nodes is
// empty), ClipDecal (0x10b1bda0) clips the decal quad, lifted 0.75 units
// along the unit normal, in world space against the planes through the eye
// and each edge of the polygon. The render pass runs at 24-bit precision, so
// every operation is a binary32 operation (Rust f32), in the listing's order
// (docs/decals.md; .work/decals/render.md section 2).

/// binary32 sqrt: the correctly rounded double root rounded to float is the
/// correctly rounded float root (PC24 FSQRT).
fn sqrt32(x: f32) -> f32 {
    trace::sqrt(x as f64) as f32
}
/// Render's inline TransformPointBy (0x10b1c061): d = p - Origin, then
/// (dx*A.x + dy*A.y) + dz*A.z per axis.
fn transform_point(p: [f32; 3], c: &[f32; 12]) -> [f32; 3] {
    let (dx, dy, dz) = (p[0] - c[0], p[1] - c[1], p[2] - c[2]);
    let mut out = [0f32; 3];
    for (a, k) in [3usize, 6, 9].iter().enumerate() {
        out[a] = (dx * c[*k] + dy * c[*k + 1]) + dz * c[*k + 2];
    }
    out
}
fn fv(b: V) -> [f32; 3] {
    [f32::from_bits(b[0]), f32::from_bits(b[1]), f32::from_bits(b[2])]
}

/// ClipDecal's geometry for one decal and one saved polygon (camera-space
/// points `poly`): the fragment's world points and, per point, the U and V
/// dot products before the division by DrawScale. Returns the count.
fn clip_decal(coords: &[f32; 12], uncoords: &[f32; 12], base: [f32; 3], normal: [f32; 3], verts: &[[f32; 3]; 4],
    poly: &[[f32; 3]], mover: Option<[i32; 3]>, out: &mut [[f32; 5]; 24]) -> Result<usize, u32> {
    // On a Mover's surface (0x10b1bfa3..0x10b1c0df): each vertex through
    // GMath.UnitCoords *= FRotator(Actor.Rotation - MoverRotation) (Core
    // 0x1011ac80), as the inlined TransformPointBy, at the pass's 24 bits.
    let mut rotated = *verts;
    if let Some(delta) = mover {
        use crate::tracker::{ld3, mul_rotator, tvb, Fp, P24, UNIT};
        let mut c = UNIT;
        mul_rotator::<P24>(&mut c, delta);
        for v in rotated.iter_mut() {
            let b = [v[0].to_bits(), v[1].to_bits(), v[2].to_bits()];
            let o = ld3::<P24>(c[0]);
            let d = [P24::ld(b[0]).sub(o[0]), P24::ld(b[1]).sub(o[1]), P24::ld(b[2]).sub(o[2])];
            let r = tvb::<P24>(d, &c);
            *v = [f32::from_bits(r[0]), f32::from_bits(r[1]), f32::from_bits(r[2])];
        }
    }
    let verts = &rotated;
    let mut n = normal;
    let ss = (n[0] * n[0] + n[1] * n[1]) + n[2] * n[2];
    if !((ss as f64) < 1e-8) {
        let r = 1.0 / sqrt32(ss);
        n = [n[0] * r, n[1] * r, n[2] * r];
    }
    n = [n[0] * 0.75, n[1] * 0.75, n[2] * 0.75];
    let mut w: [[f32; 3]; 25] = [[0.0; 3]; 25];
    let mut d: [f32; 25] = [0.0; 25];
    let mut count = 4usize;
    for k in 0..4 {
        let v = verts[k];
        w[k] = [(v[0] + base[0]) + n[0], n[1] + (v[1] + base[1]), n[2] + (v[2] + base[2])];
    }
    let mut world: [[f32; 3]; 24] = [[0.0; 3]; 24];
    if poly.len() > 24 {
        return Err(FAULT_CLIP_ASSERT);
    }
    for (k, p) in poly.iter().enumerate() {
        world[k] = transform_point(*p, uncoords);
    }
    let pts = &world[..poly.len()];
    let o = [coords[0], coords[1], coords[2]];
    let mut prev = pts.len().wrapping_sub(1);
    for j in 0..pts.len() {
        let (pj, pp) = (pts[j], pts[prev]);
        let a = [o[0] - pj[0], o[1] - pj[1], o[2] - pj[2]];
        let e = [pp[0] - pj[0], pp[1] - pj[1], pp[2] - pj[2]];
        let nn = [e[1] * a[2] - e[2] * a[1], e[2] * a[0] - e[0] * a[2], e[0] * a[1] - e[1] * a[0]];
        let wd = (pj[1] * nn[1] + pj[2] * nn[2]) + pj[0] * nn[0];
        let dot = |q: [f32; 3]| (nn[2] * q[2] + nn[1] * q[1]) + nn[0] * q[0];
        for i in 0..count {
            d[i] = dot(w[i]) - wd;
        }
        let mut i = 0usize;
        while i < count {
            let nx = if i + 1 == count { 0 } else { i + 1 };
            let (di, dn) = (d[i], d[nx]);
            // An unordered distance counts as below zero.
            let split = (di > 0.0 && !(dn >= 0.0)) || (!(di >= 0.0) && dn > 0.0);
            if split {
                let dd = [w[nx][0] - w[i][0], w[nx][1] - w[i][1], w[nx][2] - w[i][2]];
                let den = (nn[2] * dd[2] + nn[1] * dd[1]) + nn[0] * dd[0];
                let t = (wd - dot(w[i])) / den;
                let x = [t * dd[0] + w[i][0], t * dd[1] + w[i][1], t * dd[2] + w[i][2]];
                if count >= 24 {
                    return Err(FAULT_CLIP_ASSERT);
                }
                let mut s = count;
                while s > i + 1 {
                    w[s] = w[s - 1];
                    d[s] = d[s - 1];
                    s -= 1;
                }
                w[i + 1] = x;
                d[i + 1] = 0.0;
                count += 1;
                i += 1;
            }
            i += 1;
        }
        let mut i = 0usize;
        while i < count {
            if !(d[i] >= 0.0) {
                for s in i..count - 1 {
                    w[s] = w[s + 1];
                    d[s] = d[s + 1];
                }
                count -= 1;
            } else {
                i += 1;
            }
        }
        if count == 0 {
            return Ok(0);
        }
        prev = j;
    }
    // U and V: in-plane distances from V0 along unit(V1 - V0), unit(V3 - V0).
    let (v0, v1, v3) = (verts[0], verts[1], verts[3]);
    let e1 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
    let inv1 = 1.0 / sqrt32((e1[0] * e1[0] + e1[1] * e1[1]) + e1[2] * e1[2]);
    let ud = [e1[0] * inv1, e1[1] * inv1, e1[2] * inv1];
    let e3 = [v3[0] - v0[0], v3[1] - v0[1], v3[2] - v0[2]];
    let inv3 = 1.0 / sqrt32((e3[2] * e3[2] + e3[1] * e3[1]) + e3[0] * e3[0]);
    let vd = [e3[0] * inv3, e3[1] * inv3, e3[2] * inv3];
    for k in 0..count {
        let p = w[k];
        let r = [(p[0] - base[0]) - v0[0], (p[1] - base[1]) - v0[1], (p[2] - base[2]) - v0[2]];
        let u = (r[0] * ud[0] + r[1] * ud[1]) + r[2] * ud[2];
        let v = (vd[2] * r[2] + vd[1] * r[1]) + vd[0] * r[0];
        out[k] = [p[0], p[1], p[2], u, v];
    }
    Ok(count)
}

/// The decal block over one OccludeBsp result: `frame` the 64 frame words
/// (Coords at 0, Uncoords at 48), `stream` the occlusion's output stream run
/// with saved points (option 0x100). Writes fragments to `out` as [actor,
/// surface, count, count x (world x, y, z, U dot, V dot)] in stream order and
/// returns the words written; u32::MAX when `cap` words are not enough.
#[no_mangle]
pub extern "C" fn decal_clip_frame(model: u32, store: u32, frame: u32, stream: u32, words: u32, out: u32, cap: u32) -> u32 {
    unsafe {
        let m = Model::load(model);
        let st = Store { at: store };
        let rdf = |i: u32| f32::from_bits(word(frame + 4 * i));
        let mut coords = [0f32; 12];
        let mut uncoords = [0f32; 12];
        for k in 0..12 {
            coords[k] = rdf(k as u32);
            uncoords[k] = rdf(48 + k as u32);
        }
        let rd = |i: u32| word(stream + 4 * i);
        let mut i = 0u32;
        let mut written = 0u32;
        let mut frag = [[0f32; 5]; 24];
        let mut poly: [[f32; 3]; 24] = [[0.0; 3]; 24];
        while i < words {
            let tag = rd(i);
            if tag == 0xffff_fffe || tag == 0xffff_ffff {
                // A sprite's or a child request's span lines.
                let (start, end) = if tag == 0xffff_fffe { (rd(i + 2) as i32, rd(i + 3) as i32) } else { (rd(i + 5) as i32, rd(i + 6) as i32) };
                i += if tag == 0xffff_fffe { 5 } else { 8 };
                for _ in start..end {
                    let count = rd(i);
                    i += 1 + 2 * count;
                }
                continue;
            }
            let surf = rd(i + 2);
            let polys = rd(i + 6);
            i += 7;
            let has = surf < st.surf_count() && st.head(surf) >= 0;
            for _ in 0..polys {
                let node = rd(i);
                let count = rd(i + 1) as usize;
                let points_at = i + 2;
                i += 2 + 7 * count as u32;
                if !has || count == 0 {
                    continue;
                }
                if count > 24 {
                    set_io(53, FAULT_CLIP_ASSERT);
                    return u32::MAX - 1;
                }
                for k in 0..count {
                    let p = points_at + 7 * k as u32;
                    poly[k] = [f32::from_bits(rd(p)), f32::from_bits(rd(p + 1)), f32::from_bits(rd(p + 2))];
                }
                let s = match m.surf(surf) {
                    Ok(s) => s,
                    Err(code) => {
                        set_io(53, code);
                        return u32::MAX - 1;
                    }
                };
                let (base, normal) = match (m.point(s.base), m.vector(s.normal)) {
                    (Ok(b), Ok(n)) => (fv(b), fv(n)),
                    _ => {
                        set_io(53, FAULT_MODEL);
                        return u32::MAX - 1;
                    }
                };
                let mut r = st.head(surf);
                while r >= 0 {
                    let at = st.rec(r);
                    let nodes = word(at + 76);
                    let listed = nodes == 0 || (0..nodes).any(|k| word(at + 80 + 4 * k) == node);
                    if listed {
                        let vb = st.vertices(r);
                        let verts = [fv(vb[0]), fv(vb[1]), fv(vb[2]), fv(vb[3])];
                        // No FDecal is on a Mover surface yet (AttachDecal's Mover branch is fault 6).
                        match clip_decal(&coords, &uncoords, base, normal, &verts, &poly[..count], None, &mut frag) {
                            Ok(0) => {}
                            Ok(n) => {
                                let need = 3 + 5 * n as u32;
                                if written + need > cap {
                                    return u32::MAX;
                                }
                                let o = out + 4 * written;
                                set_word(o, st.actor(r));
                                set_word(o + 4, surf);
                                set_word(o + 8, n as u32);
                                for k in 0..n {
                                    for c in 0..5 {
                                        set_word(o + 12 + 4 * (5 * k + c) as u32, frag[k][c].to_bits());
                                    }
                                }
                                written += need;
                            }
                            Err(code) => {
                                set_io(53, code);
                                return u32::MAX - 1;
                            }
                        }
                    }
                    r = st.next(r);
                }
            }
        }
        written
    }
}

/// One ClipDecal for scripts/validate-decal-render.mjs: at `inp` the words
/// Coords (12), Uncoords (12), base (3), normal (3), Vertices (12), the point
/// count and the camera-space points (3 each); writes count x (world x, y, z,
/// U dot, V dot) to `out` and returns the count (u32::MAX on a fault).
#[no_mangle]
pub extern "C" fn decal_clip_test(inp: u32, out: u32) -> u32 {
    unsafe {
        let r = |i: u32| f32::from_bits(word(inp + 4 * i));
        let mut coords = [0f32; 12];
        let mut uncoords = [0f32; 12];
        for k in 0..12 {
            coords[k] = r(k as u32);
            uncoords[k] = r(12 + k as u32);
        }
        let base = [r(24), r(25), r(26)];
        let normal = [r(27), r(28), r(29)];
        let mut verts = [[0f32; 3]; 4];
        for k in 0..4 {
            verts[k] = [r(30 + 3 * k as u32), r(31 + 3 * k as u32), r(32 + 3 * k as u32)];
        }
        let count = word(inp + 4 * 42) as usize;
        if count > 24 {
            return u32::MAX;
        }
        let mut poly = [[0f32; 3]; 24];
        for k in 0..count {
            poly[k] = [r(43 + 3 * k as u32), r(44 + 3 * k as u32), r(45 + 3 * k as u32)];
        }
        let mut frag = [[0f32; 5]; 24];
        // Words 115..118: a Mover surface flag and Actor.Rotation - MoverRotation.
        let mover = if word(inp + 4 * 115) != 0 {
            Some([word(inp + 4 * 116) as i32, word(inp + 4 * 117) as i32, word(inp + 4 * 118) as i32])
        } else {
            None
        };
        match clip_decal(&coords, &uncoords, base, normal, &verts, &poly[..count], mover, &mut frag) {
            Ok(n) => {
                for k in 0..n {
                    for c in 0..5 {
                        set_word(out + 4 * (5 * k + c) as u32, frag[k][c].to_bits());
                    }
                }
                n as u32
            }
            Err(_) => u32::MAX,
        }
    }
}
