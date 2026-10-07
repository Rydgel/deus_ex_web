/** The XViewportWindow family against Extension.dll
 * (scripts/native-window-viewport-oracle.py).
 *
 * Each case builds a root (with its parent pawn and integer multipliers), a
 * parent window and a ViewportWindow, actors at their native offsets
 * (Location +0x114, Rotation +0x120, the +0x28 flags with bHidden and
 * bDeleteMe, Pawn ViewRotation +0x3dc, EyeHeight +0x3f8, bBehindView +0x318,
 * FovAngle +0x410, PlayerPawn AdditionalViews +0x6a8, PlayerPawnExt's actor
 * table +0x898/+0x998), a GC with its canvas, viewport and render device and
 * the player's renderer, then runs steps through src/runtime/
 * script-window-viewport.mjs and the original bodies. Every step's result,
 * event stream (XWindow Init/CleanUp/Draw/PostDraw, CalcView with its outs,
 * CreateMasterFrame, ComputeRenderSize, ClearZ, DrawWorld,
 * FinishMasterFrame, the XGC fallback, each with the frame rectangle and the
 * player/origin flags of that moment) and the viewport, actor, actor-table,
 * AdditionalViews and canvas state must match, floats as bits.
 * docs/script-window-viewport.md. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync, writeFileSync, rmSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {createNativeHeap} from '../src/runtime/script-native-heap.mjs';
import * as T from '../src/runtime/script-window-tree-natives.mjs';
import * as VP from '../src/runtime/script-window-viewport.mjs';
import {createActorReferenceTable, addActorReference, removeActorReference, isActorReferenceValid} from '../src/runtime/script-window-actor-refs.mjs';
import {gameDirectory} from './game-directory.mjs';

const f = Math.fround;
const view = new DataView(new ArrayBuffer(4));
const bits = v => (view.setFloat32(0, v, true), view.getUint32(0, true));
const float = b => (view.setUint32(0, b >>> 0, true), view.getFloat32(0, true));
const B = v => v.map(bits);

// A screen: root (multipliers 2, 2), a client window and the viewport at
// (12.5, 20) size 200 x 150 in the client at (100, 50).
const world = (extra = {}) => ({
  windows: [
    {id: 'root', family: 'root', type: 3, flags: 7, width: 640, height: 480, clip: [0, 0, 0, 0, 640, 480], multipliers: [2, 2], ...extra.root},
    {id: 'client', parent: 'root', x: 100, y: 50, width: 300, height: 260, clip: [100, 50, 0, 0, 300, 260], flags: 7},
    {id: 'view', family: 'viewport', parent: 'client', x: 12.5, y: 20, width: 200, height: 150, clip: [112.5, 70, 0, 0, 200, 150], flags: 7, ...extra.view},
  ],
  actors: [
    {id: 'jc', kind: 'playerpawn', location: B([100, 200, 48]), rotation: [0, 16384, 0], viewRotation: [-2000, 8192, 0], eyeHeight: bits(38.5), fov: bits(75)},
    {id: 'camera', kind: 'actor', location: B([-512.25, 300.5, 192]), rotation: [-4096, 30000, 0]},
    {id: 'guard', kind: 'pawn', location: B([0, -100, 40]), rotation: [0, -16384, 0], eyeHeight: bits(31), flags: 0},
    {id: 'drone', kind: 'actor', location: B([10, 20, 30]), rotation: [100, 200, 300]},
    ...(extra.actors ?? []),
  ],
  player: 'jc', ...extra.case,
});
const init = {op: 'init', parent: 'client'};
const cases = [
  {name: 'Init: the player is the origin, flags, fov 90, a black default colour', ...world(), steps: [init]},
  {name: 'SetViewportActor(camera): references, AdditionalViews, lastLocation; Draw renders the camera frame', ...world(), steps: [
    init, {op: 'setViewportActor', actor: 'camera'}, {op: 'draw'}, {op: 'postDraw'}]},
  {name: 'a player origin uses its ViewRotation and eye height; weapons shown only from the player', ...world(), steps: [
    init, {op: 'draw'}, {op: 'postDraw'}, {op: 'showWeapons', value: 1}, {op: 'showViewportActor', value: 1}, {op: 'draw'}, {op: 'postDraw'}]},
  {name: 'a pawn origin adds its eye height to Location and keeps its Rotation', ...world(), steps: [
    init, {op: 'setViewportActor', actor: 'guard', eyeLevel: 1}, {op: 'draw'}, {op: 'postDraw'},
    {op: 'setViewportActor', actor: 'guard', eyeLevel: 0, enable: 1}, {op: 'draw'}]},
  {name: 'relative location and rotation move and turn the frame', ...world(), steps: [
    init, {op: 'setViewportActor', actor: 'camera'}, {op: 'setRelativeLocation', location: B([30, -40, 12.75])},
    {op: 'setRelativeRotation', rotation: [512, -1024, 64]}, {op: 'draw'}, {op: 'postDraw'}]},
  {name: 'SetViewportLocation and SetWatchActor look at a pawn eye; SetRotation drops the watch', ...world(), steps: [
    init, {op: 'setViewportLocation', location: B([64, -32.5, 128])}, {op: 'setWatchActor', actor: 'guard', eyeLevel: 1},
    {op: 'draw'}, {op: 'postDraw'}, {op: 'setRotation', rotation: [-1000, 2000, -3000]}, {op: 'draw'}, {op: 'postDraw'}]},
  {name: 'a destroyed origin and watch keep the last frame', ...world(), steps: [
    init, {op: 'setViewportActor', actor: 'drone'}, {op: 'setRelativeRotation', rotation: [300, -700, 11]}, {op: 'draw'}, {op: 'postDraw'},
    {op: 'actorFlags', actor: 'drone', flags: 0x80}, {op: 'draw'}, {op: 'postDraw'},
    {op: 'setViewportActor', actor: 'camera'}, {op: 'setWatchActor', actor: 'guard'}, {op: 'draw'}, {op: 'postDraw'},
    {op: 'actorFlags', actor: 'drone', flags: 0x80}, {op: 'actorFlags', actor: 'guard', flags: 0x80}, {op: 'draw'}, {op: 'postDraw'}]},
  {name: 'without bUseViewRotation a player origin uses its Rotation; weapons only from the player', ...world(), steps: [
    init, {op: 'set', win: 'view', offset: 0x14c, value: 0x6b}, {op: 'draw'}, {op: 'postDraw'},
    {op: 'setViewportActor', actor: 'camera'}, {op: 'showWeapons', value: 1}, {op: 'draw'}, {op: 'postDraw'}]},
  {name: 'RemoveAdditionalView moves the later views down and keeps the last slot', ...world({case: {additionalViews: ['camera', 'drone', 'guard']}}), steps: [
    init, {op: 'setViewportActor', actor: 'camera'}, {op: 'setViewportActor', actor: null}, {op: 'setViewportActor', actor: 'drone'}]},
  {name: 'CalcView overrides the frame', ...world({case: {calcView: {location: B([1, 2, 3]), rotation: [4, 5, 6]}}}), steps: [
    init, {op: 'setViewportActor', actor: 'camera'}, {op: 'draw'}, {op: 'postDraw'}]},
  {name: 'the canvas frame offsets the rectangle; no ClearZ when disabled', ...world({case: {canvas: {frame: [7, 9]}}}), steps: [
    init, {op: 'setViewportActor', actor: 'camera'}, {op: 'clearZBuffer', value: 0}, {op: 'draw'}, {op: 'postDraw'}]},
  {name: 'disabled, no renderer or no frame: the default texture pattern instead', ...world({case: {renderer: false}}), steps: [
    init, {op: 'setDefaultTexture', texture: 0x1234, color: 0x80402010}, {op: 'draw'}, {op: 'enableViewport', value: 0}, {op: 'draw'}]},
  {name: 'no canvas viewport draws the default pattern', ...world({case: {canvas: {viewport: false}}}), steps: [init, {op: 'draw'}]},
  {name: 'CreateMasterFrame returning none draws the default pattern', ...world({case: {noFrame: true}}), steps: [init, {op: 'draw'}]},
  {name: 'a zero-sized window renders nothing', ...world({view: {width: 0, clip: [112.5, 70, 0, 0, 0.4, 150]}}), steps: [init, {op: 'draw'}, {op: 'postDraw'}]},
  {name: 'SetFOVAngle clamps to [0.1, 179]', ...world(), steps: [init,
    ...[45, 179, 179.5, 0.1, 0.05, -3, NaN, 0].map(v => ({op: 'setFOVAngle', bits: Number.isNaN(v) ? 0x7fc00000 : bits(v)}))]},
  {name: 'CleanUp releases the origin', ...world(), steps: [init, {op: 'setViewportActor', actor: 'camera'}, {op: 'cleanUp'}]},
  {name: 'ConvertVectorToCoordinates projects through the frame or returns its centre', ...world(), steps: [init,
    {op: 'convert', vector: B([10, 20, 300]), frame: {0x34: 0, 0x38: 0, 0x3c: 0, 0x40: bits(1), 0x44: 0, 0x48: 0, 0x4c: 0, 0x50: bits(1), 0x54: 0,
      0x58: 0, 0x5c: 0, 0x60: bits(1), 0xc8: bits(100), 0xcc: bits(75), 0xdc: bits(100)}},
    {op: 'convert', vector: B([10, 20, -5]), frame: {0x40: bits(1), 0x50: bits(1), 0x60: bits(1), 0xc8: bits(100.75), 0xcc: bits(75.25), 0xdc: bits(100)}},
    {op: 'convert', vector: B([-3.3, 7.7, 2.5]), frame: {0x34: bits(0.5), 0x38: bits(-1), 0x3c: bits(0.25), 0x40: bits(0.6), 0x44: bits(0.8), 0x48: 0,
      0x4c: bits(-0.8), 0x50: bits(0.6), 0x54: 0, 0x58: 0, 0x5c: 0, 0x60: bits(1), 0xc8: bits(100), 0xcc: bits(75), 0xdc: bits(120.5)}}]},
];

// ---- original ------------------------------------------------------------
const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
const run = spawnSync(python, ['scripts/native-window-viewport-oracle.py', gameDirectory()],
  {input: JSON.stringify({cases}), encoding: 'utf8', maxBuffer: 64e6});
if (run.status !== 0) throw new Error(`viewport oracle failed: ${run.stderr || run.stdout}`);
const original = JSON.parse(run.stdout).results;
if (process.env.VIEWPORT_DUMP) console.log(JSON.stringify(original[Number(process.env.VIEWPORT_DUMP)].steps, null, 0).slice(0, 4000));

// ---- translation ---------------------------------------------------------
const SIZE = {window: 0x160, root: 0x744, viewport: 0x1b4};
function translate(c, M) {
  const heap = createNativeHeap(), events = [], ids = new Map(), objects = new Map();
  const ref = value => value === null || value === undefined || value === 0 ? null
    : typeof value === 'number' ? (() => { try { return ids.get(heap.objectAt(value)); } catch { return undefined; } })() ?? `0x${value.toString(16).padStart(8, '0')}`
    : ids.get(value) ?? `unknown`;
  const W = {
    heap, addressOf: v => heap.addressOf(v), uobjectConstructor: () => {},
    u8: (o, off) => heap.read(o, off, 'u8'), u32: (o, off) => heap.read(o, off, 'u32'), i32: (o, off) => heap.read(o, off, 'i32'),
    f32: (o, off) => heap.read(o, off, 'f32'), ptr: (o, off) => heap.read(o, off, 'ptr'),
    setU8: (o, off, v) => heap.write(o, off, 'u8', v & 0xff), setU32: (o, off, v) => heap.write(o, off, 'u32', v >>> 0),
    setI32: (o, off, v) => heap.write(o, off, 'i32', v | 0), setF32: (o, off, v) => heap.write(o, off, 'f32', f(v)),
    setPtr: (o, off, v) => heap.write(o, off, 'ptr', v),
  };
  const make = (id, size) => { const o = {id}; heap.allocate(o, size); ids.set(o, id); objects.set(id, o); return o; };
  const at = id => objects.get(id);
  for (const spec of c.windows) make(spec.id, SIZE[spec.family ?? 'window']);
  for (const spec of c.windows) {
    const win = at(spec.id);
    W.setU8(win, 0x28, spec.type ?? 0); W.setU32(win, 0x30, spec.flags ?? 7);
    [['x', 0x78], ['y', 0x7c], ['width', 0x80], ['height', 0x84]].forEach(([k, o]) => W.setF32(win, o, spec[k] ?? 0));
    (spec.clip ?? [0, 0, 0, 0, 0, 0]).forEach((v, i) => W.setF32(win, 0xd4 + 4 * i, v));
    if (spec.parent) {
      const parent = at(spec.parent), last = W.ptr(parent, 0x140);
      W.setPtr(win, 0x138, parent);
      if (last) { W.setPtr(last, 0x148, win); W.setPtr(win, 0x144, last); } else W.setPtr(parent, 0x13c, win);
      W.setPtr(parent, 0x140, win);
    }
  }
  const actors = new Map();
  for (const spec of c.actors) {
    const a = make(spec.id, 0xa00); actors.set(a, spec);
    W.setU32(a, 0x28, spec.flags ?? 0);
    (spec.location ?? [0, 0, 0]).forEach((b, i) => W.setU32(a, 0x114 + 4 * i, b));
    (spec.rotation ?? [0, 0, 0]).forEach((v, i) => W.setI32(a, 0x120 + 4 * i, v));
    W.setU32(a, 0x3f8, spec.eyeHeight ?? 0);
    (spec.viewRotation ?? [0, 0, 0]).forEach((v, i) => W.setI32(a, 0x3dc + 4 * i, v));
    W.setU32(a, 0x318, spec.pawnFlags ?? 0); W.setU32(a, 0x410, spec.fov ?? 0);
  }
  const player = c.player ? at(c.player) : null;
  const views = [0, 1, 2].map(i => c.additionalViews?.[i] ? at(c.additionalViews[i]) : null), table = createActorReferenceTable();
  const isDeleted = a => Boolean(W.u32(a, 0x28) & 0x80);
  const rootWin = at('root');
  W.setPtr(rootWin, 0x588, player); W.setI32(rootWin, 0x730, 2); W.setI32(rootWin, 0x734, 2);
  const render = c.renderer === false ? null : make('render', 0x100);
  const gc = make('gc', 0x100), canvas = make('canvas', 0x100), viewport = make('viewport', 0x100);
  make('rendev', 0x40);
  W.setPtr(gc, 0x28, canvas);
  if (c.canvas?.viewport !== false) W.setPtr(canvas, 0x78, viewport);
  W.setI32(canvas, 0x60, 640); W.setI32(canvas, 0x64, 480); W.setF32(canvas, 0x3c, 640); W.setF32(canvas, 0x40, 480);
  if (c.canvas?.frame) { const cf = make('canvasFrame', 0x100); W.setI32(cf, 0xb0, c.canvas.frame[0]); W.setI32(cf, 0xb4, c.canvas.frame[1]); W.setPtr(canvas, 0x7c, cf); }
  const vpWin = at('view');
  let frames = 0;
  const frameState = frame => {
    const state = {frame: ref(frame)};
    if (frame) Object.assign(state, {x: W.i32(frame, 0xa8), y: W.i32(frame, 0xac), xb: W.i32(frame, 0xb0), yb: W.i32(frame, 0xb4)});
    if (player) Object.assign(state, {behindView: W.u32(player, 0x318) & 1, fov: W.u32(player, 0x410)});
    const origin = W.ptr(vpWin, 0x15c);
    if (origin) state.originHidden = (W.u32(origin, 0x28) >> 1) & 1;
    return state;
  };
  const kind = a => actors.get(a)?.kind ?? 'actor';
  const env = {
    windowInit: (win, parent) => events.push({op: 'XWindow::Init', object: ref(win), args: [ref(parent)]}),
    windowCleanUp: win => events.push({op: 'XWindow::CleanUp', object: ref(win), args: []}),
    windowDraw: (win, g) => events.push({op: 'XWindow::Draw', object: ref(win), args: [ref(g)]}),
    windowPostDraw: (win, g) => events.push({op: 'XWindow::PostDraw', object: ref(win), args: [ref(g)]}),
    getRootWindow: win => T.getRootWindow(W, win),
    getPlayerPawn: win => { const r = T.getRootWindow(W, win); return r ? W.ptr(r, 0x588) : null; },
    addActorRef: (win, a) => { if (env.getPlayerPawn(win)) addActorReference(table, a, isDeleted); },
    removeActorRef: (win, a) => { if (env.getPlayerPawn(win)) removeActorReference(table, a, isDeleted); },
    isActorValid: (win, a) => env.getPlayerPawn(win) ? isActorReferenceValid(table, a, isDeleted) : false,
    actor: {
      location: a => [0, 1, 2].map(i => W.f32(a, 0x114 + 4 * i)),
      rotation: a => [0, 1, 2].map(i => W.i32(a, 0x120 + 4 * i)),
      viewRotation: a => [0, 1, 2].map(i => W.i32(a, 0x3dc + 4 * i)),
      eyeHeight: a => W.f32(a, 0x3f8),
      isPawn: a => ['pawn', 'playerpawn'].includes(kind(a)), isPlayerPawn: a => kind(a) === 'playerpawn',
      hidden: a => (W.u32(a, 0x28) >> 1) & 1, setHidden: (a, v) => W.setU32(a, 0x28, (W.u32(a, 0x28) & ~2) | (v ? 2 : 0)),
      behindView: a => W.u32(a, 0x318) & 1, setBehindView: (a, v) => W.setU32(a, 0x318, (W.u32(a, 0x318) & ~1) | (v ? 1 : 0)),
      fovBits: a => W.u32(a, 0x410), setFovBits: (a, v) => W.setU32(a, 0x410, v),
      addAdditionalView: (p, a) => M.addAdditionalView(views, a),
      removeAdditionalView: (p, a) => M.removeAdditionalView(views, a),
    },
    render: {
      getRenderer: () => player ? render : null,
      createMasterFrame(renderer, vp, location, rotation) {
        events.push({op: 'CreateMasterFrame', renderer: ref(renderer), viewport: ref(vp), location: location.map(bits), rotation: [...rotation]});
        if (c.noFrame) { frames++; return null; }
        return make(`frame${frames++}`, 0x100);
      },
      computeRenderSize: frame => events.push({op: 'ComputeRenderSize', ...frameState(frame)}),
      clearZ: (vp, frame) => events.push({op: 'ClearZ', rendev: 'rendev', frame: ref(frame)}),
      drawWorld(renderer, frame) {
        events.push({op: 'DrawWorld', ...frameState(frame),
          canvas: [W.i32(canvas, 0x60), W.i32(canvas, 0x64), W.u32(canvas, 0x3c), W.u32(canvas, 0x40), ref(W.ptr(canvas, 0x7c))]});
      },
      finishMasterFrame: renderer => events.push({op: 'FinishMasterFrame', renderer: ref(renderer)}),
    },
    processScript(win, name, args) {
      events.push({op: 'ProcessScript', window: ref(win), name, params: [ref(args[0]), ref(args[1]), args[2].map(bits), [...args[3]]], third: 0});
      if (c.calcView) { args[2] = c.calcView.location.map(float); args[3] = [...c.calcView.rotation]; }
    },
    gc: {
      pushGC: g => events.push({op: 'PushGC', object: ref(g), args: []}),
      setStyle: (g, s) => events.push({op: 'SetStyle', object: ref(g), args: [s & 0xff]}),
      setTileColor: (g, color) => events.push({op: 'SetTileColor', object: ref(g),
        args: [color >>> 24 === heap.addressOf(at('client')) >>> 24 ? `parentHigh:${(color & 0xffffff).toString(16)}` : color >>> 0]}),
      drawPattern: (g, ...a) => events.push({op: 'DrawPattern', object: ref(g), args: [...a.slice(0, 6).map(v => bits(v)), ref(a[6])]}),
      popGC: g => events.push({op: 'PopGC', object: ref(g), args: []}),
    },
  };
  const snapshot = () => {
    const state = {};
    // Init's defaultColor alpha is the parent pointer's high byte (the oracle
    // allocates from 0x20000000, this heap from 0x21000000).
    const color = W.u32(vpWin, 0x158), parentHigh = heap.addressOf(at('client')) >>> 24;
    state.view = {flags: W.u32(vpWin, 0x14c), fov: W.u32(vpWin, 0x150), defaultTexture: W.u32(vpWin, 0x154),
      defaultColor: color >>> 24 === parentHigh ? `parentHigh:${(color & 0xffffff).toString(16)}` : color,
      origin: ref(W.ptr(vpWin, 0x15c)), watch: ref(W.ptr(vpWin, 0x160)),
      location: [0, 1, 2].map(i => W.u32(vpWin, 0x164 + 4 * i)), relLocation: [0, 1, 2].map(i => W.u32(vpWin, 0x170 + 4 * i)),
      rotation: [0, 1, 2].map(i => W.i32(vpWin, 0x17c + 4 * i)), relRotation: [0, 1, 2].map(i => W.i32(vpWin, 0x188 + 4 * i)),
      privateFlags: W.u32(vpWin, 0x194), lastLocation: [0, 1, 2].map(i => W.u32(vpWin, 0x198 + 4 * i)),
      lastRotation: [0, 1, 2].map(i => W.i32(vpWin, 0x1a4 + 4 * i)), frame: ref(W.u32(vpWin, 0x1b0) ? heap.objectAt(W.u32(vpWin, 0x1b0)) : null),
      windowFlags38: W.u32(vpWin, 0x38)};
    for (const a of actors.keys()) state[`actor:${a.id}`] = {flags: W.u32(a, 0x28), pawnFlags: W.u32(a, 0x318), fov: W.u32(a, 0x410)};
    if (player) {
      state.refs = table.slots.slice(0, table.count).map(s => [ref(s.actor), s.refs]);
      state.additionalViews = views.map(v => ref(v));
    }
    state.canvas = [W.i32(canvas, 0x60), W.i32(canvas, 0x64), W.u32(canvas, 0x3c), W.u32(canvas, 0x40), ref(W.ptr(canvas, 0x7c))];
    return state;
  };
  const results = [];
  for (const step of c.steps) {
    const mark = events.length;
    let result = null;
    const actor = key => step[key] ? at(step[key]) : null;
    switch (step.op) {
      case 'init': M.initViewportWindow(W, vpWin, at(step.parent), env); result = 0; break;
      case 'cleanUp': M.cleanUpViewportWindow(W, vpWin, env); result = 0; break;
      case 'draw': M.viewportDraw(W, vpWin, gc, env); result = 0; break;
      case 'postDraw': M.viewportPostDraw(W, vpWin, gc, env); result = 0; break;
      case 'setViewportActor': M.setViewportActor(W, vpWin, actor('actor'), step.eyeLevel ?? 1, step.enable ?? 1, env); result = 0; break;
      case 'setViewportLocation': M.setViewportLocation(W, vpWin, step.location.map(float), step.enable ?? 1, env); result = 0; break;
      case 'setWatchActor': M.setWatchActor(W, vpWin, actor('actor'), step.eyeLevel ?? 1, env); result = 0; break;
      case 'setRotation': M.setViewportRotation(W, vpWin, step.rotation, env); result = 0; break;
      case 'setRelativeRotation': step.rotation.forEach((v, i) => W.setI32(vpWin, 0x188 + 4 * i, v)); result = 0; break;
      case 'setRelativeLocation': step.location.forEach((v, i) => W.setU32(vpWin, 0x170 + 4 * i, v)); result = 0; break;
      case 'enableViewport': W.setU32(vpWin, 0x14c, (W.u32(vpWin, 0x14c) & ~1) | (step.value & 1)); result = 0; break;
      case 'showViewportActor': W.setU32(vpWin, 0x14c, (W.u32(vpWin, 0x14c) & ~4) | ((step.value & 1) << 2)); result = 0; break;
      case 'showWeapons': W.setU32(vpWin, 0x14c, (W.u32(vpWin, 0x14c) & ~8) | ((step.value & 1) << 3)); result = 0; break;
      case 'clearZBuffer': W.setU32(vpWin, 0x14c, (W.u32(vpWin, 0x14c) & ~2) | ((step.value & 1) << 1)); result = 0; break;
      case 'setFOVAngle': M.setFovAngle(W, vpWin, float(step.bits)); result = 0; break;
      case 'setDefaultTexture': W.setU32(vpWin, 0x154, step.texture ?? 0); W.setU32(vpWin, 0x158, step.color >>> 0); result = 0; break;
      case 'moveActor': step.location.forEach((b, i) => W.setU32(at(step.actor), 0x114 + 4 * i, b)); break;
      case 'actorFlags': W.setU32(at(step.actor), 0x28, step.flags); break;
      case 'set': W.setU32(at(step.win), step.offset, step.value); break;
      case 'convert': {
        const frame = make('convertFrame', 0x100);
        for (const [off, value] of Object.entries(step.frame)) W.setU32(frame, Number(off), value);
        W.setPtr(vpWin, 0x1b0, frame);
        const r = M.viewportVectorToCoordinates(W, vpWin, step.vector.map(float));
        result = [r.visible ? 1 : 0, bits(r.x), bits(r.y)];
        break;
      }
      default: throw new Error(`unknown op ${step.op}`);
    }
    results.push({result, events: events.slice(mark), state: snapshot()});
  }
  return results;
}

const reshape = (c, steps) => steps.map((s, i) => {
  // The oracle's results: setters/void calls return EAX (not compared).
  const op = c.steps[i].op;
  const result = op === 'convert' ? s.result : ['moveActor', 'actorFlags', 'set'].includes(op) ? null : 0;
  const state = {...s.state};
  const color = state.view.defaultColor;
  if (color >>> 24 === 0x20) state.view = {...state.view, defaultColor: `parentHigh:${(color & 0xffffff).toString(16)}`};
  const events = s.events.map(e => e.op === 'SetTileColor' && e.args[0] >>> 24 === 0x20
    ? {...e, args: [`parentHigh:${(e.args[0] & 0xffffff).toString(16)}`]} : e);
  return {result, events, state};
});
let compared = 0;
const failures = [];
for (const [index, c] of cases.entries()) {
  const expected = original[index].steps;
  const stopped = expected.find(s => s.stopped);
  if (stopped) throw new Error(`${c.name}: the original stopped: ${JSON.stringify(stopped)}`);
  const actual = translate(c, VP), want = reshape(c, expected);
  for (const [i, step] of want.entries()) {
    try { assert.deepEqual(actual[i], step, `${c.name}, step ${i} ${JSON.stringify(c.steps[i])}`); }
    catch (error) { failures.push(error.message.slice(0, 3000)); break; }
  }
  compared += want.length;
}
if (failures.length) { console.error(failures.join('\n\n')); process.exit(1); }

// ---- mutations: each deliberately wrong copy of the module must diverge ----
const MUTATIONS = [
  ["      if (pawn && (flags & B.useEyeHeight)) location[2]", "      if (pawn) location[2]", 'eye height without bUseEyeHeight'],
  ["playerOrigin && (flags & B.useViewRotation) ? A_.viewRotation(playerOrigin)", "playerOrigin ? A_.viewRotation(playerOrigin)", 'ViewRotation without the flag'],
  ["A_.setBehindView(player, !((flags & B.showWeapons) && player === playerOrigin));", "A_.setBehindView(player, !(flags & B.showWeapons));", 'weapons shown from any origin'],
  ["if (origin) A_.setHidden(origin, !(flags & B.showActor));", "", 'origin not hidden'],
  ["let xb = T(M(A(X(W.f32(win, 0xdc)), X(W.f32(win, 0xd4))), I(hMul)));", "let xb = T(M(X(W.f32(win, 0xdc)), I(hMul)));", 'rectangle without the clip origin'],
  ["if (flags & B.clearZ) env.render.clearZ(viewport, frame);", "env.render.clearZ(viewport, frame);", 'ClearZ always'],
  ["a < 0.1 || Number.isNaN(a) ?", "a < 0.1 ?", 'NaN FOV kept'],
  ["    for (let k = i; k < 2; k++) views[k] = views[k + 1];", "    for (let k = i; k < 2; k++) views[k] = views[k + 1];\n    views[2] = null;", 'RemoveAdditionalView clears the last slot'],
  ["    setRot(W, win, V.rotation, last.map((v, i) => (v - rel[i]) | 0));", "    setRot(W, win, V.rotation, last);", 'a destroyed origin keeps the relative rotation'],
  ["      if (player !== actor) env.actor.addAdditionalView(player, actor);", "      env.actor.addAdditionalView(player, actor);", 'the player is added as its own view'],
];
const moduleFile = new URL('../src/runtime/script-window-viewport.mjs', import.meta.url);
const source = readFileSync(moduleFile, 'utf8');
const caught = [], missed = [];
for (const [i, [find, replace, note]] of MUTATIONS.entries()) {
  if (source.split(find).length !== 2) throw new Error(`mutation ${i} (${note}): find string does not occur once`);
  const file = new URL(`../src/runtime/.mut-viewport-${process.pid}-${i}.mjs`, import.meta.url);
  writeFileSync(file, source.replace(find, replace));
  try {
    const M = await import(file.href);
    let detail = null;
    for (const [index, c] of cases.entries()) {
      let got;
      try { got = translate(c, M); } catch { detail = `${c.name}: threw`; break; }
      if (!isDeepStrictEqual(got, reshape(c, original[index].steps))) { detail = c.name; break; }
    }
    (detail ? caught : missed).push(`${note}${detail ? ` -> ${detail}` : ''}`);
  } finally { rmSync(file, {force: true}); }
}
if (missed.length) { console.error(`undetected mutations: ${missed.join('; ')}`); process.exit(1); }
if (process.env.VIEWPORT_VERBOSE) console.log(caught.join('\n'));
console.log(JSON.stringify({cases: cases.length, steps: compared, mismatches: 0, mutations: `${caught.length}/${MUTATIONS.length} detected`}));
