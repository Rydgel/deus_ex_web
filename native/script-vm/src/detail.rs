//! D3DDrv's detail-texture pass (UD3DRenderDevice::DrawComplexSurface 0x1000486e..0x10004d0b) over one OccludeBsp result
//! (docs/frame-projection.md "Detail textures"): the fans it hands DrawPrimitiveVB, from the saved polygons' FTransform points.
//!
//! The pass runs under the render pass's precision control 24, so each x87 result is one binary32 operation in the
//! instructions' order (Rust never fuses or reassociates). `src/runtime/detail-pass.mjs` is the JavaScript reference of this
//! file, and scripts/validate-detail-pass.mjs compares both with the original run under Unicorn.
//!
//! Three layers: fade distance D = 380 * 0.2367985^k and texture scale 4.223^k (each stored as binary32 after its multiply).
//! A polygon with a vertex of view depth below D becomes the clip of the polygon at D: per vertex, the vertex where the edge
//! from the previous one crosses D, then the vertex itself when inside. Inside vertices repeat the base pass' vertex (X, Y,
//! depth, RHW) with colour 0x808080 | alpha << 24; clip vertices have the layer's clip depth, RHW 1/D, colour 0x808080.
//!
//! The host's inputs, u32 words (`detail_run`):
//!   fields   the frame's ComputeRenderSize words: Coords 0..12 (origin, X, Y, Z axes), FX15 14, FY15 15, Proj.Z 21, RProj.Z 24
//!   xb, yb   the frame's rectangle offset (integers); zbias, zscale: SetRes' _33 and _43 (f32 bits)
//!   table    one 16-word record per model surface: [0] a detail texture (0: none), [1..4) the base point, [4..7) the texture U
//!            axis, [7..10) the V axis (world f32 bits), [10] UIndex, [11] VIndex, [12] UScale, [13] VScale, [14] Pan.X,
//!            [15] Pan.Y (f32 bits); `surfs` records in all
//!   stream   the occlusion's output words (option 0x100: saved points), one frame's
//! The output, per draw list record whose surface has a detail texture and a polygon with a vertex inside the first layer's
//! distance: [list, iNode, iSurf, fans], then per fan [layer, first vertex, count, count x 7 words (X, Y, depth, RHW, colour,
//! the words at vertex + 0x14 and + 0x18)]. `first` is the index of the polygon's first vertex among the record's polygons.
//! The return value is the words written, `u32::MAX` when `cap` is too small.

use crate::occlude::fistp;

const PF_PORTAL: u32 = 0x0400_0000;
const MAX_POINTS: usize = 64;
const MAX_POLYS: usize = 256;
const LAYERS: usize = 3;
/// D3DDrv 0x10018640 and 0x10018644: the fade and scale factors, and 100.0 (0x10018648).
const FADE: f32 = f32::from_bits(0x3e72_7b4d);
const SCALE: f32 = f32::from_bits(0x4087_22d1);

unsafe fn word(address: u32) -> u32 {
    core::ptr::read_unaligned(address as *const u32)
}

#[derive(Clone, Copy, Default)]
struct Pt {
    x: f32,
    y: f32,
    z: f32,
    sx: f32,
    sy: f32,
    rz: f32,
}

struct Frame {
    origin: [f32; 3],
    axes: [[f32; 3]; 3],
    rproj: f32,
    xb: i32,
    yb: i32,
    zbias: f32,
    zscale: f32,
}

impl Frame {
    /// ClipBspSurf's view transform of a model point (frame-projection.mjs `viewPoint`).
    fn view_point(&self, p: [f32; 3]) -> [f32; 3] {
        let d = [p[0] - self.origin[0], p[1] - self.origin[1], p[2] - self.origin[2]];
        let mut out = [0.0; 3];
        for k in 0..3 {
            let a = self.axes[k];
            out[k] = (d[0] * a[0] + d[1] * a[1]) + d[2] * a[2];
        }
        out
    }
    /// FVector::TransformVectorBy (Core 0x10119e40).
    fn view_vector(&self, v: [f32; 3]) -> [f32; 3] {
        let mut out = [0.0; 3];
        for k in 0..3 {
            let a = self.axes[k];
            out[k] = (v[0] * a[0] + v[1] * a[1]) + v[2] * a[2];
        }
        out
    }
}

/// A vertex' MapCoords projection (D3DDrv 0x10004082..0x100040cb): z and y terms first.
fn raw_uv(origin: [f32; 3], u: [f32; 3], v: [f32; 3], p: &Pt) -> [f32; 2] {
    let d = [p.x - origin[0], p.y - origin[1], p.z - origin[2]];
    let dot = |a: [f32; 3]| (d[2] * a[2] + d[1] * a[1]) + d[0] * a[0];
    [dot(u), dot(v)]
}

#[no_mangle]
pub extern "C" fn detail_run(fields: u32, xb: i32, yb: i32, zbias: u32, zscale: u32, table: u32, surfs: u32, stream: u32, words: u32, out: u32, cap: u32) -> u32 {
    unsafe {
        let rf = |i: u32| f32::from_bits(word(fields + 4 * i));
        let frame = Frame {
            origin: [rf(0), rf(1), rf(2)],
            axes: [[rf(3), rf(4), rf(5)], [rf(6), rf(7), rf(8)], [rf(9), rf(10), rf(11)]],
            rproj: rf(24),
            xb,
            yb,
            zbias: f32::from_bits(zbias),
            zscale: f32::from_bits(zscale),
        };
        let rd = |i: u32| word(stream + 4 * i);
        let mut at = 0u32;
        let mut i = 0u32;
        let emit = |v: u32, at: &mut u32| -> bool {
            if *at >= cap {
                return false;
            }
            core::ptr::write_unaligned((out + 4 * *at) as *mut u32, v);
            *at += 1;
            true
        };
        let mut poly_at = [0u32; MAX_POLYS];
        let mut counts = [0usize; MAX_POLYS];
        while i < words {
            let tag = rd(i);
            if tag == 0xffff_fffe || tag == 0xffff_ffff {
                let (start, end) = if tag == 0xffff_fffe { (rd(i + 6) as i32, rd(i + 7) as i32) } else { (rd(i + 5) as i32, rd(i + 6) as i32) };
                i += if tag == 0xffff_fffe { 9 } else { 8 };
                for _ in start..end {
                    i += 1 + 2 * rd(i);
                }
                continue;
            }
            let (list, node, surf, poly_flags, poly_count) = (rd(i), rd(i + 1), rd(i + 2), rd(i + 4), rd(i + 6));
            i += 7;
            // The record's polygons: the points when the stream carries them (`count` is 0 otherwise).
            let enabled = surf < surfs && word(table + 64 * surf) != 0 && poly_flags & PF_PORTAL == 0;
            let mut n = 0usize;
            for _ in 0..poly_count {
                let count = rd(i + 1) as usize;
                let points_at = i + 2;
                i += 2 + 7 * count as u32;
                if !enabled {
                    continue;
                }
                if count > 0 && count <= MAX_POINTS && n < MAX_POLYS {
                    poly_at[n] = points_at;
                    counts[n] = count;
                    n += 1;
                }
            }
            if !enabled || n == 0 {
                continue;
            }
            let t = table + 64 * surf;
            let rv = |j: u32| f32::from_bits(word(t + 4 * j));
            let origin = frame.view_point([rv(1), rv(2), rv(3)]);
            let u = frame.view_vector([rv(4), rv(5), rv(6)]);
            let v = frame.view_vector([rv(7), rv(8), rv(9)]);
            let (u_index, v_index, u_scale, v_scale, pan_x, pan_y) = (word(t + 40) as usize, word(t + 44) as usize, rv(12), rv(13), rv(14), rv(15));
            let header = at;
            for v in [list, node, surf, 0] {
                if !emit(v, &mut at) {
                    return u32::MAX;
                }
            }
            let mut fans = 0u32;
            let mut distance = 380.0f32;
            let mut scale = 1.0f32;
            for layer in 0..LAYERS {
                let rhw_d = 1.0f32 / distance;
                let clip_depth = rhw_d * frame.zscale + frame.zbias;
                let mut first = 0u32;
                for k in 0..n {
                    let count = counts[k];
                    let mut loaded = [Pt::default(); MAX_POINTS];
                    for j in 0..count {
                        let a = poly_at[k] + 7 * j as u32;
                        let f = |q: u32| f32::from_bits(rd(a + q));
                        loaded[j] = Pt { x: f(0), y: f(1), z: f(2), sx: f(3), sy: f(4), rz: f(6) };
                    }
                    let poly = &loaded[..count];
                    let mut inside = [false; MAX_POINTS];
                    let mut any = false;
                    for (j, p) in poly.iter().enumerate() {
                        inside[j] = p.z < distance;
                        any |= inside[j];
                    }
                    if any {
                        let mut vertices = [[0u32; 7]; 2 * MAX_POINTS];
                        let mut m = 0usize;
                        let mut put = |m: &mut usize, sx: f32, sy: f32, sz: f32, rhw: f32, color: u32, uu: f32, vv: f32| {
                            let mut w = [sx.to_bits(), sy.to_bits(), sz.to_bits(), rhw.to_bits(), color, 0, 0];
                            w[5 + u_index] = uu.to_bits();
                            w[5 + v_index] = vv.to_bits();
                            vertices[*m] = w;
                            *m += 1;
                        };
                        let mut previous = count - 1;
                        for j in 0..count {
                            let a = &poly[j];
                            let b = &poly[previous];
                            if inside[j] != inside[previous] {
                                let tt = (a.z - distance) / (a.z - b.z);
                                let s = 1.0f32 - tt;
                                let xp = (tt * b.sx) * b.z;
                                let x = ((xp + (a.sx * a.z) * s) * rhw_d + frame.xb as f32) - 0.5;
                                let yp = (b.sy * b.z) * tt;
                                let y = ((yp + (a.sy * a.z) * s) * rhw_d + frame.yb as f32) - 0.5;
                                let ra = raw_uv(origin, u, v, a);
                                let rb = raw_uv(origin, u, v, b);
                                let uu = (((s * ra[0] + tt * rb[0]) - pan_x) * u_scale) * scale;
                                let vv = (((s * ra[1] + tt * rb[1]) - pan_y) * v_scale) * scale;
                                put(&mut m, x, y, clip_depth, rhw_d, 0x0080_8080, uu, vv);
                            }
                            if inside[j] {
                                let alpha = fistp(((distance / a.z) - 1.0) * 100.0) as u32;
                                let alpha = if alpha > 255 { 255 } else { alpha };
                                let r = raw_uv(origin, u, v, a);
                                let uu = ((r[0] - pan_x) * u_scale) * scale;
                                let vv = ((r[1] - pan_y) * v_scale) * scale;
                                let rhw = a.rz * frame.rproj;
                                let sx = (frame.xb as f32 + a.sx) - 0.5;
                                let sy = (frame.yb as f32 + a.sy) - 0.5;
                                let sz = rhw * frame.zscale + frame.zbias;
                                put(&mut m, sx, sy, sz, rhw, alpha << 24 | 0x0080_8080, uu, vv);
                            }
                            previous = j;
                        }
                        for v in [layer as u32, first, m as u32] {
                            if !emit(v, &mut at) {
                                return u32::MAX;
                            }
                        }
                        for w in &vertices[..m] {
                            for &x in w {
                                if !emit(x, &mut at) {
                                    return u32::MAX;
                                }
                            }
                        }
                        fans += 1;
                    }
                    first += count as u32;
                }
                scale = scale * SCALE;
                distance = distance * FADE;
            }
            if fans == 0 {
                at = header;
            } else {
                core::ptr::write_unaligned((out + 4 * (header + 3)) as *mut u32, fans);
            }
        }
        at
    }
}
