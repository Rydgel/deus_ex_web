import pass0 from './crt-royale-first-pass-linearize-crt-gamma-bob-fields.mjs';
import pass1 from './crt-royale-scanlines-vertical-interlacing.mjs';
import pass2 from './crt-royale-bloom-approx.mjs';
import pass3 from './blur9fast-vertical.mjs';
import pass4 from './blur9fast-horizontal.mjs';
import pass5 from './crt-royale-mask-resize-vertical.mjs';
import pass6 from './crt-royale-mask-resize-horizontal.mjs';
import pass7 from './crt-royale-scanlines-horizontal-apply-mask.mjs';
import pass8 from './crt-royale-brightpass.mjs';
import pass9 from './crt-royale-bloom-vertical.mjs';
import pass10 from './crt-royale-bloom-horizontal-reconstitute.mjs';
import pass11 from './crt-royale-geometry-aa-last-pass.mjs';
export const passes = [
  { ...{"file":"crt-royale-first-pass-linearize-crt-gamma-bob-fields.glsl","alias":"ORIG_LINEARIZED","linear":false,"x":{"type":"source","scale":1},"y":{"type":"source","scale":1}}, source: pass0 },
  { ...{"file":"crt-royale-scanlines-vertical-interlacing.glsl","alias":"VERTICAL_SCANLINES","linear":true,"x":{"type":"source","scale":1},"y":{"type":"viewport","scale":1}}, source: pass1 },
  { ...{"file":"crt-royale-bloom-approx.glsl","alias":"BLOOM_APPROX","linear":true,"x":{"type":"absolute","scale":320},"y":{"type":"absolute","scale":240}}, source: pass2 },
  { ...{"file":"blur9fast-vertical.glsl","alias":null,"linear":true,"x":{"type":"source","scale":1},"y":{"type":"source","scale":1}}, source: pass3 },
  { ...{"file":"blur9fast-horizontal.glsl","alias":"HALATION_BLUR","linear":true,"x":{"type":"source","scale":1},"y":{"type":"source","scale":1}}, source: pass4 },
  { ...{"file":"crt-royale-mask-resize-vertical.glsl","alias":null,"linear":true,"x":{"type":"absolute","scale":64},"y":{"type":"viewport","scale":0.0625}}, source: pass5 },
  { ...{"file":"crt-royale-mask-resize-horizontal.glsl","alias":"MASK_RESIZE","linear":false,"x":{"type":"viewport","scale":0.0625},"y":{"type":"source","scale":1}}, source: pass6 },
  { ...{"file":"crt-royale-scanlines-horizontal-apply-mask.glsl","alias":"MASKED_SCANLINES","linear":true,"x":{"type":"viewport","scale":1},"y":{"type":"viewport","scale":1}}, source: pass7 },
  { ...{"file":"crt-royale-brightpass.glsl","alias":"BRIGHTPASS","linear":true,"x":{"type":"viewport","scale":1},"y":{"type":"viewport","scale":1}}, source: pass8 },
  { ...{"file":"crt-royale-bloom-vertical.glsl","alias":null,"linear":true,"x":{"type":"source","scale":1},"y":{"type":"source","scale":1}}, source: pass9 },
  { ...{"file":"crt-royale-bloom-horizontal-reconstitute.glsl","alias":null,"linear":true,"x":{"type":"source","scale":1},"y":{"type":"source","scale":1}}, source: pass10 },
  { ...{"file":"crt-royale-geometry-aa-last-pass.glsl","alias":null,"linear":true,"x":{"type":"viewport","scale":1},"y":{"type":"viewport","scale":1}}, source: pass11 }
];
export const masks = [
  {name: "mask_grille_texture_small", mipmap: false, url: new URL("./TileableLinearApertureGrille15Wide8And5d5SpacingResizeTo64.png", import.meta.url).href},
  {name: "mask_grille_texture_large", mipmap: true, url: new URL("./TileableLinearApertureGrille15Wide8And5d5Spacing.png", import.meta.url).href},
  {name: "mask_slot_texture_small", mipmap: false, url: new URL("./TileableLinearSlotMaskTall15Wide9And4d5Horizontal9d14VerticalSpacingResizeTo64.png", import.meta.url).href},
  {name: "mask_slot_texture_large", mipmap: true, url: new URL("./TileableLinearSlotMaskTall15Wide9And4d5Horizontal9d14VerticalSpacing.png", import.meta.url).href},
  {name: "mask_shadow_texture_small", mipmap: false, url: new URL("./TileableLinearShadowMaskEDPResizeTo64.png", import.meta.url).href},
  {name: "mask_shadow_texture_large", mipmap: true, url: new URL("./TileableLinearShadowMaskEDP.png", import.meta.url).href}
];
