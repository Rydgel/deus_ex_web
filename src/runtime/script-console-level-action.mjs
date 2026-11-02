/**
 * The loading frame (docs/loading-frame.md): the frame UGameEngine::LoadMap draws of the level it leaves, and the Canvas text natives
 * the console's message goes through.
 *
 * LoadMap (Engine 0x1038c1f0), with a client, its first viewport and a level (0x1038c36d..0x1038c38c): LevelInfo.LevelAction (+0x510)
 * = LEVACT_Loading (0x1038c3e0; LEVACT_Connecting at 0x1038c446 for a pending net level, not reached in single player), Pauser (+0x4e0)
 * = "" (0x1038c49c..0x1038c4fc), the viewport actor's bShowMenu (+0x69c bit 21) cleared (0x1038c51d), PaintProgress (vtable +0xb8,
 * 0x10388740), the audio viewport refresh, LevelAction = LEVACT_None (0x1038c59b). PaintProgress swaps the actor's FlashFog (+0x61c)
 * for (0, 0, 0) and FlashScale (+0x610) for (0.1, 0.1, 0.1), calls Draw(Viewport, 1, NULL, NULL) (vtable +0x78) and swaps them back:
 * a whole frame of the old level, the HUD windows included (the PostRenderFlash event), darkened by EndFlash (alpha 25), then the
 * console's PostRender event (Draw 0x1038f772, after EndFlash) and its DrawLevelAction: LoadingMessage centred in LargeFont, STY_Translucent,
 * DrawColor (0, 0, 255). DeusEx.dll's SaveCurrentLevel (0x1000fac0) calls PaintProgress too (0x1000fd83), with LevelAction =
 * LEVACT_Saving (0x1000fd7a) and nothing else changed, before it files the level (`paintProgress`): SavingMessage, the same way.
 * Engine.Console.PrintActionMessage measures it with Canvas.StrLen and draws it with Canvas.DrawText:
 *
 * - execStrLen (native 464, 0x10377650): CurX and CurY truncated to int and zeroed, WrappedStrLenf (vtable +0x68, 0x10377380) =
 *   WrappedPrint(STY_None, ..., Center 0), CurX and CurY restored from the ints, XL and YL from the ints.
 * - execDrawText (native 465, 0x103778f0): no Font logs "DrawText: No font"; Style != STY_None: WrappedPrint(Style, XL, YL, Font,
 *   bCenter & 1, Text); CurX += XL; CurYL = max(CurYL, YL); CR (default 1): CurY += CurYL, CurX = 0, CurYL = 0.
 * - WrappedPrint (0x10376790): the word-wrapping line loop; DrawString (0x10376d20) draws a line glyph by glyph and the tile submit
 *   (0x10377170) rejects or clips each glyph against the frame before RenDev->DrawTile.
 *
 * Every Play frame runs the console's part of UGameEngine::Draw (docs/console.md): UConsole::PreRender's Tick event before the world,
 * and after the HUD the viewport actor's and the console's PostRender events, whose DrawSingleView draws the typed line ("(> Say _")
 * and the last messages with these natives. The loading frame runs the same tail; on it LoadMap has just cleared bShowMenu and Pauser.
 * DrawTile (466) draws the full console's background (Shift+` while typing) and the border patterns, for the console's own textures.
 */
import {exportAt, readObject} from '../unreal/objects.mjs';
import {refValue} from './script-vm.mjs';
import {decodeFontExport} from './script-font-model.mjs';
import {plainTexture} from './script-window-plain-texture.mjs';
import {TextureStore} from '../unreal/textures.mjs';
import {canvasDrawTile} from './sprite-tile.mjs';

export const LEVEL_ACTION = Object.freeze({none: 0, loading: 1, saving: 2, connecting: 3, precaching: 4});
export const LOADING_FRAME = Object.freeze({
  loadMap: 0x1038c1f0, loadingAction: 0x1038c3e0, pauserCleared: 0x1038c49c, showMenuCleared: 0x1038c51d, paintProgressCall: 0x1038c52e,
  actionCleared: 0x1038c59b, paintProgress: 0x10388740, draw: 0x1038f110, consolePostRender: 0x1038f772,
  consolePreRender: 0x10379d10, consolePostRenderNative: 0x10379f70, canvasUpdate: 0x10377560,
  execStrLen: 0x10377650, execDrawText: 0x103778f0, wrappedStrLenf: 0x10377380, wrappedPrint: 0x10376790, drawString: 0x10376d20,
  tileSubmit: 0x10377170,
  // PaintProgress's stand-ins for the viewport actor's FlashScale and FlashFog (0x1038877b..0x10388789, 0x10388764..0x10388772)
  flashScale: Object.freeze([0.1, 0.1, 0.1]), flashFog: Object.freeze([0, 0, 0]),
});
const STR_LEN = 464, DRAW_TEXT = 465, DRAW_TILE = 466;
const f32 = Math.fround, ftol = Math.trunc;   // _ftol (0x10413652 -> MSVCRT): truncation

/** WrappedPrint's PolyFlags (0x1037684e..0x10376887): STY_None PF_Invisible, STY_Translucent PF_Translucent, STY_Modulated PF_Modulated,
 * other styles none; with PF_Masked | PF_NoSmooth | 0x01000000. */
export function textPolyFlags(style) {
  return (style === 0 ? 0x1 : style === 3 ? 0x4 : style === 4 ? 0x40 : 0) | 0x1000802;
}

/** WrappedPrint's character size (0x103768d4..0x10376918): page = ch / CharactersPerPage, a page or glyph past the arrays is (0, 0). */
function charSize(font, ch) {
  const page = ftol(ch / font.charsPerPage), rem = ch - page * font.charsPerPage, chars = font.pages[page]?.chars;
  return page < font.pages.length && rem < chars.length ? [chars[rem][2], chars[rem][3]] : [0, 0];
}

/** DrawString (0x10376d20) with WrappedPrint's arguments (no clip, no '&' hot key): each glyph whose page has a texture goes to the tile
 * submit at (ftol(X + acc + OrgX), ftol(Y + OrgY)), and the line advances ftol(USize + SpaceX). Returns the advance. */
function drawString(canvas, polyFlags, font, x, y, text, tile) {
  let acc = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i), page = ftol(ch / font.charsPerPage);
    if (page >= font.pages.length) continue;
    const entry = font.pages[page], rem = ch - page * font.charsPerPage;
    if (!entry.texture || rem >= entry.chars.length) continue;
    const [u, v, w, h] = entry.chars[rem];
    submitTile(canvas, polyFlags, entry.texture, ftol(f32(x + acc) + canvas.orgX), ftol(f32(y) + canvas.orgY), w, h, u, v, tile);
    acc += ftol(w + canvas.spaceX);
  }
  return acc;
}

/** The tile submit (0x10377170) of a glyph (UL = XL, VL = YL): PF_Invisible draws nothing; a tile outside the canvas frame (Frame->X,
 * Frame->Y, +0xa8 and +0xac) or without area is dropped. The frame clips it in integers (0x103771de..0x1037727c), with idiv's
 * truncation: left of 0, d = X * UL / XL, UL += d, U -= d, XL = X + XL, X = 0; above 0 the same in Y; past the right edge
 * UL += (FrameX - X - XL) * UL / XL, past the bottom VL alike (XL and YL stay). RenDev->DrawTile then gets UL and VL as its XL and YL
 * (0x103772bb..0x10377300: the pushes for XL and YL are the converted UL and VL): the drawn rectangle is the source's, 1:1. */
function submitTile(canvas, polyFlags, texture, x, y, w, h, u, v, tile) {
  if (polyFlags & 1) return;
  if (x + w <= 0 || y + h <= 0 || x >= canvas.frameX || y >= canvas.frameY || w <= 0 || h <= 0) return;
  let ul = w, vl = h;
  if (x < 0) { const d = Math.trunc(x * ul / w); ul += d; u -= d; w += x; x = 0; }
  if (y < 0) { const d = Math.trunc(y * vl / h); v -= d; vl += d; h += y; y = 0; }
  if (w > canvas.frameX - x) ul += Math.trunc((canvas.frameX - x - w) * ul / w);
  if (h > canvas.frameY - y) vl += Math.trunc((canvas.frameY - y - h) * vl / h);
  tile({texture, x, y, width: ul, height: vl, u, v, ul, vl, polyFlags});
}

/** UCanvas::WrappedPrint (0x10376790) over a canvas state ({spaceX, spaceY, orgX, orgY, clipX, clipY, curX, curY, frameX, frameY});
 * moves curX and curY as the native does and returns the measured {xl, yl}. `tile(record)` receives each drawn glyph. */
export function wrappedPrint(canvas, style, font, center, text, tile = () => {}) {
  let xl = 0, yl = 0;
  if (canvas.clipX < 0 || canvas.clipY < 0) return {xl, yl};
  if (!font) throw new Error('WrappedPrint requires a Font (the check at 0x103767e6)');
  const polyFlags = textPolyFlags(style);
  let at = 0;
  do {
    let testXL = ftol(canvas.curX), cleanXL = 0, testYL = 0, cleanYL = 0, gotWord = false, cleanEnd = 0, i = at;
    while (i < text.length && text.charCodeAt(i) !== 10) {
      const [w, h] = charSize(font, text.charCodeAt(i));
      testXL += ftol(w + canvas.spaceX);
      testYL = Math.max(testYL, ftol(canvas.spaceY) + h);
      if (testXL > canvas.clipX) break;
      i++;
      const next = i < text.length ? text.charCodeAt(i) : 0, wordBreak = next === 32 || next === 10 || next === 0;
      if (wordBreak || !gotWord) { cleanEnd = i - at; cleanXL = testXL; cleanYL = testYL; gotWord = gotWord || wordBreak; }
    }
    if (cleanEnd === 0) break;
    const top = f32(canvas.orgY + canvas.curY);
    if (style !== 0 && top < canvas.frameY && cleanYL + top > 0) {
      const lineX = center ? ftol((canvas.clipX - cleanXL) * 0.5 + canvas.curX) : ftol(canvas.curX);
      canvas.curX = f32(lineX + drawString(canvas, polyFlags, font, lineX, ftol(canvas.curY),
        text.slice(at, at + cleanEnd), tile));
    }
    canvas.curX = 0;
    canvas.curY = f32(cleanYL + canvas.curY);
    yl += cleanYL; xl = Math.max(xl, cleanXL);
    at += cleanEnd;
    while (text.charCodeAt(at) === 32) at++;
  } while (at < text.length);
  return {xl, yl};
}

/** execStrLen (0x10377650): the measure from (0, 0), CurX and CurY back as their truncated values. */
export function canvasStrLen(canvas, font, text) {
  const oldX = ftol(canvas.curX), oldY = ftol(canvas.curY);
  canvas.curX = 0; canvas.curY = 0;
  const {xl, yl} = wrappedPrint(canvas, 0, font, false, text);
  canvas.curY = f32(oldY); canvas.curX = f32(oldX);
  return {xl: f32(xl), yl: f32(yl)};
}

/** execDrawText (0x103778f0) after the font check. */
export function canvasDrawText(canvas, font, text, cr, tile) {
  const {xl, yl} = canvas.style !== 0 ? wrappedPrint(canvas, canvas.style, font, canvas.center, text, tile) : {xl: 0, yl: 0};
  canvas.curX = f32(canvas.curX + xl);
  canvas.curYL = canvas.curYL < yl ? f32(yl) : canvas.curYL;
  if (cr) { canvas.curY = f32(canvas.curY + canvas.curYL); canvas.curX = 0; canvas.curYL = 0; }
}

/** The glyph table of an original Font reference ({asset, index}) with each page's texture as a HUD texture reference. */
function decodeFont(ref) {
  const asset = ref.asset, entry = exportAt(asset.pkg, ref.index);
  const decoded = decodeFontExport(asset.bytes.subarray(entry.serialOffset, entry.serialOffset + entry.serialSize), ref.key);
  const reader = readObject(asset.pkg, asset.bytes, ref.index).reader;
  if (reader.compact() !== decoded.pageCount) throw new Error(`Original font page count mismatch: ${ref.key}`);
  const pages = decoded.pages.map((page, i) => {
    const textureIndex = reader.compact(), count = reader.compact();
    reader.take(count * 16);
    return {chars: page.chars, texture: textureIndex ? plainTexture({key: `${ref.key}.page${i}`, asset, index: textureIndex, kind: 'Texture'}) : null};
  });
  return {charsPerPage: decoded.charsPerPage, pages};
}

/** The console's canvas: an Engine.Canvas object, the font tables it reaches, the per-frame UConsole::PreRender (`preRender`) and the
 * PostRender events of UGameEngine::Draw's tail (`postRender`), and `paint`, which runs the PaintProgress steps around the HUD paint
 * (`hudPaint(flash)`) and the same tail after it. */
export async function createConsoleLevelAction({runtime, assets}) {
  const engine = await assets.get('Engine');
  const canvasClass = await runtime.loadClass(engine, engine.exportsByPath.get('canvas'));
  // The viewport's canvas (UViewport +0x5c), a script object of the original class; its native tail is the state this module keeps.
  const canvas = {kind: 'Canvas', key: 'viewer.console.canvas', name: 'Canvas'};
  runtime.attach(canvas, canvasClass);
  const read = (object, name) => runtime.readNamed(object, name), write = (object, name, value) => runtime.writeNamed(object, name, value);
  const fonts = new Map();
  const fontOf = ref => {
    if (!ref) return null;
    if (!ref.asset || !Number.isInteger(ref.index)) throw new Error(`Canvas font is not an original Font export: ${ref?.key ?? ref?.name ?? ref}`);
    let font = fonts.get(ref.key);
    if (!font) fonts.set(ref.key, font = decodeFont(ref));
    return font;
  };
  const state = frame => ({spaceX: read(canvas, 'SpaceX'), spaceY: read(canvas, 'SpaceY'), orgX: read(canvas, 'OrgX'), orgY: read(canvas, 'OrgY'),
    clipX: read(canvas, 'ClipX'), clipY: read(canvas, 'ClipY'), curX: read(canvas, 'CurX'), curY: read(canvas, 'CurY'), curYL: read(canvas, 'CurYL'),
    style: Number(read(canvas, 'Style')), center: Boolean(read(canvas, 'bCenter')), frameX: frame.width, frameY: frame.height});
  const store = s => { write(canvas, 'CurX', s.curX); write(canvas, 'CurY', s.curY); write(canvas, 'CurYL', s.curYL); };
  const colorOf = () => { const c = read(canvas, 'DrawColor'); return ['r', 'g', 'b'].map(k => c?.[`core.object.color.${k}`] ?? 0); };
  const consoleOf = player => { const viewport = read(player, 'Player'); return {viewport, console: viewport && read(viewport, 'Console')}; };
  // The textures the console's own DrawTile calls draw (Engine.Console's ConBackground and Border defaults): what UTexture::Lock gives
  // UCanvas::DrawTile (the base mip's size, UScale = VScale = Scale) and the PolyFlags Masked bit it adds, read before any frame (the
  // native is synchronous).
  const consoleClass = await runtime.loadClass(engine, engine.exportsByPath.get('console')), textureStore = new TextureStore(assets), tileTextures = new Map();
  for (const name of ['ConBackground', 'Border']) {
    const ref = runtime.defaultValue(consoleClass, runtime.lookupMember(consoleClass, 'fields', name));
    if (!ref?.asset || !Number.isInteger(ref.index)) continue;
    const data = await textureStore.get(ref.asset, ref.index), values = data.values ?? {}, scale = f32(values.Scale ?? 1);
    tileTextures.set(ref.key, {usize: values.USize | 0, vsize: values.VSize | 0, infoUSize: data.mips[0].width, infoVSize: data.mips[0].height,
      uScale: scale, vScale: scale, masked: Boolean(values.bMasked), animated: Boolean(values.AnimNext),
      texture: plainTexture({key: ref.key, asset: ref.asset, index: ref.index, kind: 'Texture'})});
  }
  return {
    canvas,
    /** The stock fonts' page textures the console draws with (LargeFont: DrawLevelAction's messages; MedFont: the typed line and the
     * message lines), which the page decodes before the first frame: the loading frame is drawn once and kept, and the typed line
     * shows on the frame that starts it. */
    textures() {
      return [...['LargeFont', 'MedFont'].flatMap(name => (fontOf(read(canvas, name))?.pages ?? []).map(page => page.texture)).filter(Boolean),
        ...[...tileTextures.values()].map(info => info.texture)];
    },
    /**
     * UConsole::PreRender (0x10379d10), which UGameEngine::Draw calls after Render->PreRender and before Canvas->Update (0x1038f685):
     * the Tick event with Delta = (FLOAT)(Viewport->CurrentTime - LastUpdateTime) (0x10379d3f..0x10379d62; `delta`, the page's frame
     * clock), then ConsoleLines (+0x724), BorderLines (+0x728) and BorderPixels (+0x72c) zeroed and, with ConsolePos (+0x730) above 0,
     * ConsoleLines = _ftol(min(Frame->Y * ConsolePos, Frame->Y)) (0x10379d9d..0x10379dc3; the render pass's 24-bit precision control
     * rounds the product to a float). BorderSize (+0x720) of 2 or more shrinks the frame (0x10379dd8..0x10379ea1): not translated.
     */
    preRender({player, delta, height}) {
      const {console} = consoleOf(player);
      if (!console) throw new Error('UConsole::PreRender requires the viewport Console');
      runtime.processEvent(console, 'Tick', [f32(delta)]);
      write(console, 'ConsoleLines', 0); write(console, 'BorderLines', 0); write(console, 'BorderPixels', 0);
      const position = f32(read(console, 'ConsolePos'));
      if (position > 0) write(console, 'ConsoleLines', ftol(Math.min(f32(height * position), height)));
      if (read(console, 'BorderSize') >= 2) throw new Error('UConsole::PreRender with BorderSize >= 2 (the frame border, 0x10379dd8) is not translated');
    },
    /**
     * UGameEngine::Draw's tail after RenDev->EndFlash (0x1038f714): the viewport actor's PostRender event (0x1038f73e), then
     * UConsole::PostRender (0x10379f70: the frame PreRender kept, FrameX (+0x738) and FrameY (+0x73c) from its X and Y) and the
     * console's PostRender event (0x1038f772). Canvas->Update (0x1038f68e, before the world: the Reset event, then ClipX/SizeX and
     * ClipY/SizeY from the frame) is made here, after the HUD's paint, which writes none of the canvas's script fields. Returns the
     * console's tiles as HUD tile commands.
     */
    postRender({player, width, height}) {
      const {viewport, console} = consoleOf(player);
      if (!console) throw new Error('The console PostRender requires the viewport Console');
      write(canvas, 'Viewport', viewport);
      runtime.processEvent(canvas, 'Reset', []);
      write(canvas, 'ClipX', f32(width)); write(canvas, 'SizeX', width);
      write(canvas, 'ClipY', f32(height)); write(canvas, 'SizeY', height);
      return withCanvasNatives({width, height}, () => {
        runtime.processEvent(player, 'PostRender', [canvas]);
        write(console, 'FrameX', f32(width)); write(console, 'FrameY', f32(height));
        runtime.processEvent(console, 'PostRender', [canvas]);
      });
    },
    /**
     * One PaintProgress frame (LoadMap 0x1038c3e0..0x1038c59b with `action` LEVEL_ACTION.loading): `hudPaint()` is the frame's HUD paint
     * (PostRenderFlash), which reads the flash planes while PaintProgress has them swapped; returns its result and `console`, the console's
     * tiles after EndFlash as HUD tile commands.
     */
    paint({player, levelInfo, width, height, action, hudPaint}) {
      write(levelInfo, 'LevelAction', action);
      write(levelInfo, 'Pauser', '');
      write(player, 'bShowMenu', false);
      try { return this.paintProgress({player, width, height, hudPaint}); }
      finally { write(levelInfo, 'LevelAction', LEVEL_ACTION.none); }
    },
    /**
     * PaintProgress alone (0x10388740), with the level's LevelAction as its caller left it: SaveCurrentLevel's frame (LevelAction 2, set at
     * DeusEx 0x1000fd7a and cleared at 0x1000ffa4 after the save; Pauser and bShowMenu untouched). The flash swap around `hudPaint()`, then
     * Draw's tail (`postRender`): DrawLevelAction draws the message; returns `{hud, console}` as `paint` does. Its Draw's
     * UConsole::PreRender (the Tick event) is not run.
     */
    paintProgress({player, width, height, hudPaint}) {
      const scale = [...read(player, 'FlashScale')], fog = [...read(player, 'FlashFog')];
      write(player, 'FlashFog', LOADING_FRAME.flashFog.map(f32)); write(player, 'FlashScale', LOADING_FRAME.flashScale.map(f32));
      let hud, tiles = [];
      try {
        hud = hudPaint();
        tiles = this.postRender({player, width, height});
      } finally {
        write(player, 'FlashFog', fog); write(player, 'FlashScale', scale);
      }
      return {hud, console: tiles};
    },
  };
  /**
   * UCanvas::execDrawTile (0x10377ba0): Tex, XL, YL, U, V, UL, VL; no texture logs "DrawTile: Missing Texture" (not reached: the console's
   * textures are its defaults) and draws nothing. With a Style, PolyFlags = PF_Translucent for STY_Translucent, PF_Modulated for
   * STY_Modulated, PF_NoSmooth with bNoSmooth, and PF_TwoSided (0x10377ccd..0x10377cfd), then UCanvas::DrawTile (vtable +0x5c) at
   * (OrgX + CurX, OrgY + CurY) with DrawColor's plane and no fog (canvasDrawTile: the clip to the frame and the U/V scale, checked for
   * sprites against the original); the texture's Masked bit joins the flags. Then CurX = SpaceX + CurX + XL and CurYL = max(CurYL, YL)
   * (0x10377d6a..0x10377d88), drawn or not.
   */
  function drawTile([texture, xl, yl, u, v, ul, vl], frame, tiles) {
    [xl, yl, u, v, ul, vl] = [xl, yl, u, v, ul, vl].map(f32);
    if (!texture) throw new Error('Canvas.DrawTile without a texture (it logs "DrawTile: Missing Texture"; not modelled)');
    const style = Number(read(canvas, 'Style'));
    if (style !== 0) {
      const info = tileTextures.get(texture.key);
      if (!info) throw new Error(`Canvas.DrawTile of ${texture.key}: only the console's ConBackground and Border are prepared`);
      if (info.animated) throw new Error(`Canvas.DrawTile of an animated texture (${texture.key}): UTexture::Update and AnimCur are not translated`);
      const x = f32(read(canvas, 'CurX') + read(canvas, 'OrgX')), y = f32(read(canvas, 'CurY') + read(canvas, 'OrgY'));
      const tile = canvasDrawTile({x, y, xl, yl, u, v, ul, vl}, {fx: f32(frame.width), fy: f32(frame.height)}, info);
      // (the HUD renderer's styles: 3 translucent, 4 modulated, 2 masked, 1 opaque)
      if (tile) tiles.push({texture: info.texture, x: tile.x, y: tile.y, width: tile.xl, height: tile.yl, u: tile.u, v: tile.v, ul: tile.ul, vl: tile.vl,
        color: colorOf(), style: style === 3 ? 3 : style === 4 ? 4 : info.masked ? 2 : 1});
    }
    write(canvas, 'CurX', f32(f32(read(canvas, 'SpaceX') + read(canvas, 'CurX')) + xl));
    if (read(canvas, 'CurYL') < yl) write(canvas, 'CurYL', yl);
  }
  /** `run()` with the canvas natives bound to this canvas: StrLen (464), DrawText (465) and DrawTile (466). Returns the drawn tiles. */
  function withCanvasNatives(frame, run) {
    const tiles = [], previous = runtime.native, added = [STR_LEN, DRAW_TEXT, DRAW_TILE].filter(index => !runtime.boundaryNatives.has(index));
    for (const index of added) runtime.boundaryNatives.add(index);
    runtime.native = call => {
      if (call.index !== 464 && call.index !== 465 && call.index !== 466) return previous(call);
      if (call.receiver !== canvas) throw new Error(`Canvas native ${call.index} reached the console with another receiver`);
      const raw = Array.from({length: call.argumentCount}, (_, i) => call.evaluateArgument(i));
      if (call.index === 466) { drawTile(raw.map(refValue), frame, tiles); return undefined; }
      const text = String(refValue(raw[0]) ?? ''), font = fontOf(read(canvas, 'Font')), s = state(frame);
      if (call.index === 464) {
        if (!font) throw new Error('Canvas.StrLen without a Font');
        const {xl, yl} = canvasStrLen(s, font, text);
        store(s);
        if (raw[1]?.reference) raw[1].set(xl);
        if (raw[2]?.reference) raw[2].set(yl);
        return undefined;
      }
      if (!font) throw new Error('Canvas.DrawText: No font (execDrawText logs it and draws nothing; not modelled)');
      // (WrappedPrint's PolyFlags always carry PF_Masked (textPolyFlags): STY_Normal text is the HUD renderer's masked style 2, which
      // leaves the glyph page's index-zero texels undrawn; STY_Translucent and STY_Modulated keep their own)
      const cr = raw[1] === undefined ? true : Boolean(refValue(raw[1])), color = colorOf(), style = s.style === 1 ? 2 : s.style;
      canvasDrawText(s, font, text, cr, record => tiles.push({texture: record.texture, x: record.x, y: record.y, width: record.width,
        height: record.height, u: record.u, v: record.v, ul: record.ul, vl: record.vl, color, style}));
      store(s);
      return undefined;
    };
    try { run(); }
    finally { runtime.native = previous; for (const index of added) runtime.boundaryNatives.delete(index); }
    return tiles;
  }
}
