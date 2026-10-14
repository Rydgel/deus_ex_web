/** The original renderer's texture sampling state (docs/texture-sampling.md).
 *
 * D3DDrv's stage setup, `0x10009e20` (thiscall; jump thunk `0x10001087`), sets
 * every stage it uses (0 the base texture, 1 the light map, 2 the third pass)
 * the same way:
 *
 *   MIPMAPLODBIAS (state 0x13)  -0.5   (`0xbf000000`, `0x10009e3f` and `0x10009fac`)
 *   ADDRESS       (0x0c)         WRAP
 *   MAGFILTER     (0x10)         LINEAR (2)   `0x10009ef9`
 *   MINFILTER     (0x11)         LINEAR (2)   `0x10009f0e`
 *   MIPFILTER     (0x12)         `UseMipmapping ? (UseTrilinear ? LINEAR : POINT) : NONE`
 *                                (`0x10009f1a..0x10009f43`: the device's members `+0x9ac` and
 *                                `+0x9b0`, registered as UseMipmapping and UseTrilinear at
 *                                `0x100018e9` and `0x10001942`)
 *
 * The shipped DeusEx.ini has UseMipmapping=True, UseTrilinear=False: the mip
 * level is picked, not blended, after a bias of -0.5. A surface with PF_NoSmooth
 * (0x800) switches stage 0's MAG and MIN filters to POINT (`0x1000845f..0x10008490`:
 * `edi = (flags & 0x800 ? 1 : 2)`).
 *
 * In GL terms (what wined3d and a host both end up with) that is
 * LINEAR_MIPMAP_NEAREST with a level-of-detail bias of -0.5, and NEAREST filters
 * for PF_NoSmooth. Pixel evidence: scripts/camera-acceptance.mjs, bias -1, -0.5,
 * -0.25 and 0 against the original's frames of a camera screen: the mean absolute
 * difference is lowest at -0.5 (docs/visual-acceptance.md "Security cameras"). */
import * as THREE from 'three';

/** MIPMAPLODBIAS of every stage. */
export const D3D_LOD_BIAS = -0.5;
/** The bias as GLSL source (a float literal). */
export const D3D_LOD_BIAS_GLSL = '-0.5';

/** Sets a texture's filters as the device does for a surface with or without PF_NoSmooth. */
export function configureSampler(texture, noSmooth = false) {
  texture.magFilter = noSmooth ? THREE.NearestFilter : THREE.LinearFilter;
  texture.minFilter = noSmooth ? THREE.NearestMipmapNearestFilter : THREE.LinearMipmapNearestFilter;
  return texture;
}

/** three's `map_fragment` chunk with the base texture read at the device's bias. Every
 * MeshBasicMaterial that carries a `map` (world surfaces, actor skins, decals, sprites)
 * takes it: a texture without mip levels is unaffected by a bias. The chunk is replaced
 * once for the whole page; a three.js whose chunk no longer reads like this throws
 * rather than drawing unbiased. */
const SAMPLE = 'texture2D( map, vMapUv )';
if (!THREE.ShaderChunk.map_fragment.includes(`${SAMPLE};`) && !THREE.ShaderChunk.map_fragment.includes(`texture2D( map, vMapUv, ${D3D_LOD_BIAS_GLSL} )`))
  throw new Error('three.js map_fragment no longer samples texture2D( map, vMapUv ): update original-sampling.mjs');
THREE.ShaderChunk.map_fragment = THREE.ShaderChunk.map_fragment.replace(SAMPLE, `texture2D( map, vMapUv, ${D3D_LOD_BIAS_GLSL} )`);
