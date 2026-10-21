//! URender::DrawMesh's classic UMesh body (Render.dll 0x10b0d1a0, from
//! 0x10b0d235) and its face helper 0x10b0bab0, as far as the actor mesh layer
//! observes them (docs/umesh.md): the port of src/runtime/umesh-draw.mjs
//! `drawUMesh` joined with actor-umesh-sim.mjs's packing of its polygons
//! into per-corner colours and environment UVs. The JavaScript translation
//! stays the reference (`packUMeshDraw`); validate-umesh-wasm compares every
//! output word of the two.
//!
//! It runs in the render pass, at x87 precision control 24: every operation
//! below is one binary32 operation (`f32`), the addition of the double 0.001
//! to a face normal's squared length rounds the exact sum once (`r24_sum`),
//! and the light manager's Light is the LodMesh kernel's `light_vertex`.
//!
//! What it leaves out, because nothing the layer reads depends on it: the
//! shared vertex records' plain U and V (the page takes the plain UVs from
//! the triangles' bytes), the mirrored frame's swap of Pts[0] and Pts[2] and
//! the two-sided face's reordering (they only permute the corners the helper
//! hands the device; the outputs are per vertex and per corner of the
//! mesh's own triangle), the helper's polygon clipping (the GPU clips) and
//! Fog (not drawn).
use crate::lod::r24_sum;
use crate::{
    diffuse_channel, light_vertex, r24_product, table_rsqrt, LIGHT_TABLES, LIGHT_TABLE_WORDS, WORK,
};
use std::cell::RefCell;

/// One classic mesh's immutable topology: triangles (vertex indices, PolyFlags,
/// TextureIndex) and the vertex links (`Connects`/`VertLinks`).
struct Topology {
    vertex_count: usize,
    tris: Vec<[u32; 3]>,
    flags: Vec<u32>,
    texture: Vec<i32>,
    /// Per vertex: (offset into `links`, count).
    connects: Vec<(u32, u32)>,
    links: Vec<u32>,
}

thread_local! { static MESHES: RefCell<Vec<Option<Topology>>> = const { RefCell::new(Vec::new()) }; }
thread_local! { static SCRATCH: RefCell<Scratch> = RefCell::new(Scratch::default()); }

#[derive(Default)]
struct Scratch {
    point: Vec<f32>,
    code: Vec<u8>,
    normal: Vec<f32>,
    plane: Vec<f32>,
    visible: Vec<u32>,
    /// 0: not lit yet; 1: lit; the colour in `lit`.
    state: Vec<u8>,
    lit: Vec<f32>,
    /// Diffuse words of a vertex's current light, `converted_ok` when valid.
    converted: Vec<[f32; 3]>,
    converted_ok: Vec<u8>,
    env: Vec<[f32; 2]>,
    env_ok: Vec<u8>,
    lights: Vec<[f32; 7]>,
}

/// The scratch ABI's header (u32 words), then the regions below it.
pub const HEADER: usize = 48;
const H_MIRROR: usize = 0;
const H_HAS_PRJ: usize = 1;
const H_PRJ: usize = 2; // 4: PrjXM, PrjYM, PrjXP, PrjYP
const H_UNCOORDS: usize = 6; // 9: the three Uncoords axes, rows of three
const H_POLY_FLAGS: usize = 15;
const H_SETUP_FLAGS: usize = 16;
const H_FATNESS: usize = 17;
const H_UNLIT: usize = 18; // 3
const H_AMBIENT: usize = 21; // 3
const H_SCALE_GLOW: usize = 24;
/// Bit 0: the environment UVs are wanted; bit 1: also each vertex's normal plane and Light (validation).
const H_OUTPUT: usize = 25;
const H_ENV_INFO: usize = 26; // 6: present, uSize, vSize, uScale, vScale, flags
const H_KEPT: usize = 32; // out
const H_DRAWN: usize = 33; // out
const H_ALL_OUTSIDE: usize = 34; // out
const INFO_WORDS: usize = 6;

pub const STATUS_OK: u32 = 0;
/// A polygon needs the environment map and there is none (DrawMesh's error).
pub const STATUS_NO_ENVIRONMENT: u32 = 1;
pub const STATUS_INVALID: u32 = 2;

/// Word offsets of the regions after the header for one call.
pub struct Layout {
    pub textures: usize,
    pub lights: usize,
    pub points: usize,
    pub colors: usize,
    pub env_uv: usize,
    pub planes: usize,
    pub vertex_light: usize,
    pub words: usize,
}

pub fn layout(
    vertex_count: usize,
    tri_count: usize,
    texture_count: usize,
    light_count: usize,
) -> Layout {
    let textures = HEADER;
    let lights = textures + texture_count * INFO_WORDS;
    let points = lights + light_count * 7;
    let colors = points + vertex_count * 3;
    let env_uv = colors + tri_count * 9;
    let planes = env_uv + tri_count * 6;
    let vertex_light = planes + vertex_count * 4;
    let words = vertex_light + vertex_count * 3;
    Layout {
        textures,
        lights,
        points,
        colors,
        env_uv,
        planes,
        vertex_light,
        words,
    }
}

/// One region's word offset of `layout` (0 textures, 1 lights, 2 points, 3 colors, 4 env_uv, 5 planes, 6 vertex_light, 7 words), so the
/// host reads the scratch layout from the kernel that owns it.
#[no_mangle]
pub extern "C" fn umesh_layout(
    vertex_count: usize,
    tri_count: usize,
    texture_count: usize,
    light_count: usize,
    region: u32,
) -> usize {
    let at = layout(vertex_count, tri_count, texture_count, light_count);
    match region {
        0 => at.textures,
        1 => at.lights,
        2 => at.points,
        3 => at.colors,
        4 => at.env_uv,
        5 => at.planes,
        6 => at.vertex_light,
        _ => at.words,
    }
}

/// Upload a mesh's topology from WORK: `tri_count` triangles of
/// (v0, v1, v2, PolyFlags, TextureIndex), `vertex_count` (count, offset)
/// pairs of `Connects`, then `link_count` words of `VertLinks`. Returns the
/// handle, or `u32::MAX` for a topology the draw does not accept (a vertex
/// or link out of range), which keeps the JavaScript reference.
#[no_mangle]
pub extern "C" fn upload_umesh(tri_count: usize, vertex_count: usize, link_count: usize) -> u32 {
    let topology = WORK.with_borrow(|work| {
        let words = tri_count * 5 + vertex_count * 2 + link_count;
        if words > work.len() {
            return None;
        }
        let mut tris = Vec::with_capacity(tri_count);
        let mut flags = Vec::with_capacity(tri_count);
        let mut texture = Vec::with_capacity(tri_count);
        for i in 0..tri_count {
            let at = i * 5;
            let tri = [work[at], work[at + 1], work[at + 2]];
            if tri.iter().any(|&v| v as usize >= vertex_count) {
                return None;
            }
            tris.push(tri);
            flags.push(work[at + 3]);
            texture.push(work[at + 4] as i32);
        }
        let mut connects = Vec::with_capacity(vertex_count);
        let connects_at = tri_count * 5;
        let links_at = connects_at + vertex_count * 2;
        for v in 0..vertex_count {
            let (count, offset) = (work[connects_at + v * 2], work[connects_at + v * 2 + 1]);
            // A negative count or offset (or a run past the links) is not a mesh the reference reads either.
            if (count as i32) < 0
                || (offset as i32) < 0
                || offset as usize + count as usize > link_count
            {
                return None;
            }
            connects.push((offset, count));
        }
        let links: Vec<u32> = work[links_at..links_at + link_count].to_vec();
        if links.iter().any(|&t| t as usize >= tri_count) {
            return None;
        }
        Some(Topology {
            vertex_count,
            tris,
            flags,
            texture,
            connects,
            links,
        })
    });
    let Some(topology) = topology else {
        return u32::MAX;
    };
    MESHES.with_borrow_mut(|meshes| {
        if let Some(handle) = meshes.iter().position(Option::is_none) {
            meshes[handle] = Some(topology);
            handle as u32
        } else {
            meshes.push(Some(topology));
            (meshes.len() - 1) as u32
        }
    })
}

#[no_mangle]
pub extern "C" fn release_umesh(handle: u32) {
    MESHES.with_borrow_mut(|meshes| {
        if let Some(mesh) = meshes.get_mut(handle as usize) {
            *mesh = None;
        }
    });
}

/// The squared length plus the 0.001 at 0x10b2ac10, a double (the LodMesh path adds the float at 0x10b2ac2c): the exact sum rounds once.
#[inline(always)]
fn face_length(squared: f32) -> f32 {
    r24_sum(squared as f64, 0.001) as f32
}

#[inline(always)]
fn sign(value: f32) -> bool {
    value.to_bits() >> 31 != 0
}

/// 0x10b0d3c8..0x10b0d462: `z·PrjXM + x`, `z·PrjYM + y`, `z·PrjYP - y` and
/// `z·PrjXP - x`, whose sign bits select 4, 0x10, 0x20 and 8.
#[inline(always)]
fn outcode(x: f32, y: f32, z: f32, prj: Option<&[f32; 4]>) -> u8 {
    let Some(prj) = prj else { return 0 };
    let a = z * prj[0] + x;
    let b = z * prj[1] + y;
    let c = z * prj[3] - y;
    let d = z * prj[2] - x;
    (if sign(a) { 4 } else { 0 })
        | (if sign(b) { 0x10 } else { 0 })
        | (if sign(c) { 0x20 } else { 0 })
        | (if sign(d) { 8 } else { 0 })
}

/// FVector::UnsafeNormal (Core 0x10117dd0) and the face helper's PF_Environment
/// corner (0x10b0bb09..0x10b0bbb7): `n` the corner's unit direction,
/// `r = n - N·(2·(n|N))`, taken to world space by the frame's Uncoords axes,
/// then `U = ((r.x + 1)·UFactor)·128` and V likewise.
fn environment_uv(
    point: [f32; 3],
    normal: [f32; 3],
    uncoords: &[[f32; 3]; 3],
    u_factor: f32,
    v_factor: f32,
) -> [f32; 2] {
    let sum = (point[0] * point[0] + point[1] * point[1]) + point[2] * point[2];
    let scale = 1.0f32 / sum.sqrt();
    let n = [scale * point[0], scale * point[1], scale * point[2]];
    let d = (n[2] * normal[2] + n[1] * normal[1]) + n[0] * normal[0];
    let twice = 2.0f32 * d;
    let r = [
        n[0] - twice * normal[0],
        n[1] - twice * normal[1],
        n[2] - twice * normal[2],
    ];
    let world = |j: usize| (r[0] * uncoords[j][0] + r[1] * uncoords[j][1]) + r[2] * uncoords[j][2];
    [
        ((world(0) + 1.0) * u_factor) * 128.0,
        ((world(1) + 1.0) * v_factor) * 128.0,
    ]
}

#[derive(Clone, Copy)]
struct Info {
    present: bool,
    u_factor: f32,
    v_factor: f32,
    flags: u32,
}

fn info_at(work: &[u32], at: usize) -> Info {
    if work[at] == 0 {
        return Info {
            present: false,
            u_factor: 0.0,
            v_factor: 0.0,
            flags: 0,
        };
    }
    // `f(f(USize·UScale)/256)`: the base size as an integer, the scale a float.
    let u_size = work[at + 1] as f32;
    let v_size = work[at + 2] as f32;
    let u_scale = f32::from_bits(work[at + 3]);
    let v_scale = f32::from_bits(work[at + 4]);
    Info {
        present: true,
        u_factor: (u_size * u_scale) / 256.0,
        v_factor: (v_size * v_scale) / 256.0,
        flags: work[at + 5],
    }
}

/// DrawMesh's classic body over WORK (the header, the texture infos, the
/// lights and the camera-space points; see `layout`), writing the points back
/// (Fatness moves them), the per-corner colours (1.0 where nothing is
/// written: a modulated or unlit-skipped corner, an undrawn face), the
/// environment UVs and, for validation, each vertex's normal plane and Light.
/// Returns a `STATUS_*`.
#[no_mangle]
pub extern "C" fn umesh_draw(handle: u32, texture_count: usize, light_count: usize) -> u32 {
    MESHES.with_borrow(|meshes| {
        let Some(Some(mesh)) = meshes.get(handle as usize) else {
            return STATUS_INVALID;
        };
        LIGHT_TABLES.with_borrow(|tables| {
            if tables.len() != LIGHT_TABLE_WORDS {
                return STATUS_INVALID;
            }
            WORK.with_borrow_mut(|work| {
                SCRATCH.with_borrow_mut(|scratch| {
                    draw(mesh, tables, work, scratch, texture_count, light_count)
                })
            })
        })
    })
}

fn draw(
    mesh: &Topology,
    tables: &[u32],
    work: &mut [u32],
    s: &mut Scratch,
    texture_count: usize,
    light_count: usize,
) -> u32 {
    let (vertex_count, tri_count) = (mesh.vertex_count, mesh.tris.len());
    let at = layout(vertex_count, tri_count, texture_count, light_count);
    if work.len() < at.words {
        return STATUS_INVALID;
    }
    let f = |i: usize| f32::from_bits(work[i]);
    let mirror = f(H_MIRROR);
    let prj = (work[H_HAS_PRJ] != 0).then(|| [f(H_PRJ), f(H_PRJ + 1), f(H_PRJ + 2), f(H_PRJ + 3)]);
    let uncoords: [[f32; 3]; 3] =
        std::array::from_fn(|j| std::array::from_fn(|k| f(H_UNCOORDS + j * 3 + k)));
    let poly_flags = work[H_POLY_FLAGS];
    let setup_flags = work[H_SETUP_FLAGS];
    let fatness = work[H_FATNESS];
    let unlit = [f(H_UNLIT), f(H_UNLIT + 1), f(H_UNLIT + 2)];
    let ambient = [f(H_AMBIENT), f(H_AMBIENT + 1), f(H_AMBIENT + 2)];
    let scale_glow = f(H_SCALE_GLOW);
    let env_output = work[H_OUTPUT] & 1 != 0;
    let diagnostics = work[H_OUTPUT] & 2 != 0;
    let environment = info_at(work, H_ENV_INFO);
    let textures: Vec<Info> = (0..texture_count)
        .map(|i| info_at(work, at.textures + i * INFO_WORDS))
        .collect();
    s.lights.clear();
    s.lights.extend(
        (0..light_count).map(|light| std::array::from_fn(|k| f(at.lights + light * 7 + k))),
    );

    // Defaults: every corner white, no environment UV, an unlit vertex record.
    work[at.colors..at.colors + tri_count * 9].fill(1.0f32.to_bits());
    work[at.env_uv..at.env_uv + tri_count * 6].fill(0);
    if diagnostics {
        work[at.planes..at.planes + vertex_count * 4].fill(0);
        work[at.vertex_light..at.vertex_light + vertex_count * 3].fill(0);
    }
    work[H_KEPT] = 0;
    work[H_DRAWN] = 0;
    work[H_ALL_OUTSIDE] = 0;

    s.point.clear();
    s.point.extend(
        work[at.points..at.points + vertex_count * 3]
            .iter()
            .map(|&w| f32::from_bits(w)),
    );
    s.code.clear();
    s.code.resize(vertex_count, 0);
    // 0x10b0d300..0x10b0d47d: every vertex's outcode; a mesh whose vertices all share a bit (from 0x3c) is not drawn.
    let mut all = 0x3cu8;
    for i in 0..vertex_count {
        let code = outcode(
            s.point[i * 3],
            s.point[i * 3 + 1],
            s.point[i * 3 + 2],
            prj.as_ref(),
        );
        s.code[i] = code;
        all &= code;
    }
    if all != 0 {
        work[H_ALL_OUTSIDE] = 1;
        return STATUS_OK;
    }

    // 0x10b0db49..0x10b0dc6d: every triangle's face normal, kept or not.
    s.normal.clear();
    s.normal.resize(tri_count * 3, 0.0);
    for (index, tri) in mesh.tris.iter().enumerate() {
        let (a, b, c) = (
            tri[0] as usize * 3,
            tri[1] as usize * 3,
            tri[2] as usize * 3,
        );
        let p = &s.point;
        let (ax, ay, az) = (p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]);
        let (bx, by, bz) = (p[a] - p[b], p[a + 1] - p[b + 1], p[a + 2] - p[b + 2]);
        let nx = by * az - bz * ay;
        let ny = bz * ax - az * bx;
        let nz = ay * bx - by * ax;
        let length = face_length((nx * nx + ny * ny) + nz * nz);
        let scale = table_rsqrt(length, tables);
        s.normal[index * 3] = scale * nx;
        s.normal[index * 3 + 1] = scale * ny;
        s.normal[index * 3 + 2] = scale * nz;
    }

    // 0x10b0dc81..0x10b0dd8e: the kept triangles, in mesh order.
    s.visible.clear();
    for (index, tri) in mesh.tris.iter().enumerate() {
        let flags = mesh.flags[index] | poly_flags;
        let (va, vb, vc) = (tri[0] as usize, tri[1] as usize, tri[2] as usize);
        if s.code[va] & s.code[vb] & s.code[vc] != 0 {
            continue;
        }
        if flags & 0x4101 == 0x4000 {
            let a = va * 3;
            let dot = (s.normal[index * 3 + 2] * s.point[a + 2]
                + s.normal[index * 3 + 1] * s.point[a + 1])
                + s.point[a] * s.normal[index * 3];
            // An unordered compare keeps nothing.
            let facing = dot * mirror < 0.0;
            if !facing {
                continue;
            }
        }
        s.visible.push(index as u32);
    }
    work[H_KEPT] = s.visible.len() as u32;
    if s.visible.is_empty() {
        write_points(work, at.points, &s.point);
        return STATUS_OK;
    }

    // 0x10b0dffc: SetupForActor's bits join PolyFlags.
    let flags = poly_flags | setup_flags;
    let glow = r24_product(scale_glow, 1.4);
    // Fatness (`≠ 0x80`) moves a vertex by `Fatness/16 - 8` along its normal.
    let fat = (fatness != 0x80).then_some(((fatness & 255) as f64 * 0.0625 - 8.0) as f32);
    s.state.clear();
    s.state.resize(vertex_count, 0);
    s.lit.clear();
    s.lit.resize(vertex_count * 3, 0.0);
    s.plane.clear();
    s.plane.resize(vertex_count * 4, 0.0);

    // 0x10b0e029..0x10b0e2ed: for each vertex of each kept triangle, once, its normal plane and Light.
    for k in 0..s.visible.len() {
        let tri = mesh.tris[s.visible[k] as usize];
        for vertex in tri {
            let vertex = vertex as usize;
            if s.state[vertex] != 0 {
                continue;
            }
            s.state[vertex] = 1;
            let (offset, count) = mesh.connects[vertex];
            let (mut sx, mut sy, mut sz) = (0.0f32, 0.0f32, 0.0f32);
            for &t in &mesh.links[offset as usize..(offset + count) as usize] {
                let t = t as usize * 3;
                sx += s.normal[t];
                sy += s.normal[t + 1];
                sz += s.normal[t + 2];
            }
            // The squared length `(z² + y²) + x²` has no epsilon here.
            let scale = table_rsqrt((sz * sz + sy * sy) + sx * sx, tables);
            let (nz, ny, nx) = (sz * scale, sy * scale, sx * scale);
            let (px, py, pz) = (
                s.point[vertex * 3],
                s.point[vertex * 3 + 1],
                s.point[vertex * 3 + 2],
            );
            let w = (py * ny + pz * nz) + px * nx;
            s.plane[vertex * 4] = nx;
            s.plane[vertex * 4 + 1] = ny;
            s.plane[vertex * 4 + 2] = nz;
            s.plane[vertex * 4 + 3] = w;
            if let Some(fat) = fat {
                s.point[vertex * 3] = fat * nx + px;
                s.point[vertex * 3 + 1] = fat * ny + py;
                s.point[vertex * 3 + 2] = fat * nz + pz;
                s.code[vertex] = outcode(
                    s.point[vertex * 3],
                    s.point[vertex * 3 + 1],
                    s.point[vertex * 3 + 2],
                    prj.as_ref(),
                );
            }
            let here = [
                s.point[vertex * 3],
                s.point[vertex * 3 + 1],
                s.point[vertex * 3 + 2],
            ];
            let light = light_vertex(
                &s.lights,
                here,
                [nx, ny, nz, w],
                flags,
                ambient,
                glow,
                tables,
            );
            s.lit[vertex * 3..vertex * 3 + 3].copy_from_slice(&light);
        }
    }

    // 0x10b0e312..0x10b0e41f and the face helper: each kept triangle in order.
    s.converted.clear();
    s.converted.resize(vertex_count, [0.0; 3]);
    s.converted_ok.clear();
    s.converted_ok.resize(vertex_count, 0);
    s.env.clear();
    s.env.resize(vertex_count, [0.0; 2]);
    s.env_ok.clear();
    s.env_ok.resize(vertex_count, 0);
    let mut drawn = 0u32;
    for k in 0..s.visible.len() {
        let index = s.visible[k] as usize;
        let tri = mesh.tris[index];
        let mut draw_flags = mesh.flags[index] | flags;
        let own = if draw_flags & 0x10 != 0 {
            None
        } else {
            let texture = mesh.texture[index];
            (texture >= 0)
                .then(|| textures.get(texture as usize))
                .flatten()
                .filter(|info| info.present)
        };
        let info = match own {
            Some(info) => *info,
            None if environment.present => environment,
            None => return STATUS_NO_ENVIRONMENT,
        };
        draw_flags |= info.flags & 2;
        let (u_factor, v_factor) = (info.u_factor, info.v_factor);
        // The helper writes each corner's environment U and V and, for PF_Unlit, the unlit colour into the shared vertex records.
        if draw_flags & 0x400000 != 0 {
            for vertex in tri {
                let vertex = vertex as usize;
                s.lit[vertex * 3..vertex * 3 + 3].copy_from_slice(&unlit);
                s.state[vertex] = 1;
                s.converted_ok[vertex] = 0;
            }
        }
        // 0x10b0c52a: it draws nothing when the corners share an outcode bit.
        if s.code[tri[0] as usize] & s.code[tri[1] as usize] & s.code[tri[2] as usize] != 0 {
            continue;
        }
        drawn += 1;
        let environment_face = draw_flags & 0x10 != 0;
        if environment_face && env_output {
            for (corner, &corner_vertex) in tri.iter().enumerate() {
                let vertex = corner_vertex as usize;
                // The first corner of a repeated vertex.
                if tri[..corner].contains(&corner_vertex) {
                    continue;
                }
                if s.env_ok[vertex] == 0 {
                    let point = [
                        s.point[vertex * 3],
                        s.point[vertex * 3 + 1],
                        s.point[vertex * 3 + 2],
                    ];
                    let normal = [
                        s.plane[vertex * 4],
                        s.plane[vertex * 4 + 1],
                        s.plane[vertex * 4 + 2],
                    ];
                    s.env[vertex] = environment_uv(point, normal, &uncoords, u_factor, v_factor);
                    s.env_ok[vertex] = 1;
                }
                // The page divides by USize·UScale (UFactor·256): a double quotient stored as a float.
                let uv = s.env[vertex];
                let u_norm = u_factor as f64 * 256.0;
                let v_norm = v_factor as f64 * 256.0;
                work[at.env_uv + index * 6 + corner * 2] =
                    (((uv[0] as f64) / u_norm) as f32).to_bits();
                work[at.env_uv + index * 6 + corner * 2 + 1] =
                    (((uv[1] as f64) / v_norm) as f32).to_bits();
            }
        }
        if draw_flags & 0x40 != 0 {
            continue; // a modulated face keeps white corners
        }
        for (corner, &corner_vertex) in tri.iter().enumerate() {
            let vertex = corner_vertex as usize;
            if s.state[vertex] == 0 {
                continue;
            }
            if s.converted_ok[vertex] == 0 {
                s.converted[vertex] =
                    std::array::from_fn(|axis| diffuse_channel(s.lit[vertex * 3 + axis]));
                s.converted_ok[vertex] = 1;
            }
            let color = s.converted[vertex];
            let out = at.colors + index * 9 + corner * 3;
            work[out] = color[0].to_bits();
            work[out + 1] = color[1].to_bits();
            work[out + 2] = color[2].to_bits();
        }
    }
    work[H_DRAWN] = drawn;
    write_points(work, at.points, &s.point);
    if diagnostics {
        for vertex in 0..vertex_count {
            for axis in 0..4 {
                work[at.planes + vertex * 4 + axis] = s.plane[vertex * 4 + axis].to_bits();
            }
            for axis in 0..3 {
                work[at.vertex_light + vertex * 3 + axis] = s.lit[vertex * 3 + axis].to_bits();
            }
        }
    }
    STATUS_OK
}

fn write_points(work: &mut [u32], at: usize, points: &[f32]) {
    for (i, value) in points.iter().enumerate() {
        work[at + i] = value.to_bits();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Squared lengths at which the exact sum with the double 0.001 differs from adding the float 0.001f
    /// (expected words from src/runtime/x87-r24.mjs `r24sum`, the reference the oracle comparison of umesh-draw.mjs covers).
    #[test]
    fn face_length_adds_the_double_epsilon_once() {
        for (squared, want) in [
            (0x30ca19f9u32, 0x3a83127bu32),
            (0x36e759e2, 0x3a83f9c8),
            (0x339ae3a4, 0x3a8314da),
            (0x3a558e39, 0x3aedd98b),
            (0x2fb72436, 0x3a831271),
            (0x3779fdd6, 0x3a85066a),
            (0x319b0673, 0x3a831295),
            (0x36080d75, 0x3a835675),
            (0x3a349a25, 0x3add5f81),
            (0x365fc76c, 0x3a838252),
        ] {
            let got = face_length(f32::from_bits(squared));
            assert_eq!(got.to_bits(), want, "squared {squared:#010x}");
            assert_ne!(
                got.to_bits(),
                (f32::from_bits(squared) + 0.001f32).to_bits(),
                "{squared:#010x} must tell the double from the float"
            );
        }
        // Zero rounds the double to the float.
        assert_eq!(face_length(0.0).to_bits(), 0x3a83126f);
    }

    #[test]
    fn outcode_takes_sign_bits_of_the_four_planes() {
        let prj = [1.0f32, 1.0, 1.0, 1.0];
        assert_eq!(outcode(0.0, 0.0, 10.0, Some(&prj)), 0);
        assert_eq!(outcode(-20.0, 0.0, 10.0, Some(&prj)), 4); // z·PrjXM + x < 0
        assert_eq!(outcode(0.0, -20.0, 10.0, Some(&prj)), 0x10);
        assert_eq!(outcode(0.0, 20.0, 10.0, Some(&prj)), 0x20); // z·PrjYP - y < 0
        assert_eq!(outcode(20.0, 0.0, 10.0, Some(&prj)), 8); // z·PrjXP - x < 0
        assert_eq!(outcode(-0.0, 0.0, 0.0, Some(&prj)), 0);
        assert_eq!(outcode(-20.0, -20.0, 10.0, None), 0);
    }

    #[test]
    fn environment_uv_faces_back_along_the_view() {
        // Looking straight at a surface that faces the viewer reflects the view straight back: U = V = UFactor·128.
        let axes = [[1.0f32, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        assert_eq!(
            environment_uv([0.0, 0.0, 10.0], [0.0, 0.0, -1.0], &axes, 1.0, 1.0),
            [128.0, 128.0]
        );
    }
}
