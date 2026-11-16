// The film's game shots: for each, where the engine's camera is and what it looks at, who else is in the picture, and
// which of the crab's performances (video/blender/performances.py) plays in it. Points are Unreal units in the map;
// angles in degrees. film/plate-shot.mjs captures the plate, blender/game_shot.py puts the crab in it.
//   camera: {at, to} (a fixed camera at `at` looking at `to`), or {track: [[seconds, at, to], ...]} (moving, eased)
//   actors: [{cls, at (its Location), yaw, anim, cycle (seconds a loop of the animation takes; 0 holds `frame`), frame,
//             path: [[seconds, x, y], ...] (it moves along it, turned the way it goes)}]
//   floor: the height the crab stands on; light: a rig in game_shot.py (gain: its strength, 1 as made); zoom: [from, to] a slow push on the finished frame
//   into / offset: the shot's frames go to video/out/film/<into>/ starting after `offset` frames (two angles of one shot)
//   live: the level runs (people walk); otherwise it is frozen and only what is listed here moves
//   settle: seconds the level runs before the first frame (a person just loaded stands in its mesh's rest pose, arms out)
//   linear: a track or path at constant speed (otherwise eased between its keys)
//   reveal: [start, seconds] the picture draws itself outward from `around` (a point of the frame, 0..1), blocks first
const ISLAND = '01_NYC_UNATCOIsland', DOCK = -299.2, JC = 'DeusEx.JCDouble';
const rad = d => d * Math.PI / 180;
// a low camera where a map's player starts (its Location; the floor is 43.5 under it), looking along `yaw`, a little upward
const low = ([x, y, z], yaw, {height = 36, pitch = 4, ahead = 0} = {}) => {
  const at = [x + ahead * Math.cos(rad(yaw)), y + ahead * Math.sin(rad(yaw)), z - 43.5 + height];
  return {at, to: [at[0] + 300 * Math.cos(rad(yaw)), at[1] + 300 * Math.sin(rad(yaw)), at[2] + 300 * Math.tan(rad(pitch))]};
};
const postcard = (map, start, yaw, crab, light, more = {}) => ({map, frames: 124, floor: start[2] - 43.5, light, crab, zoom: [1.0, 1.05], camera: low(start, yaw, more.view), ...more});
const WALK = {from: [-4680, 10431], to: [-4150, 10431]};          // the finale's stroll along the dock

export const GAME = {
  // ---- light: the island appears
  'first-light': {map: ISLAND, bar: 24, frames: 248, floor: DOCK, light: 'dock', crab: 'first_light', zoom: [1.0, 1.06], reveal: [0.25, 3.4], around: [0.44, 0.74],
    camera: low([-4761, 10431, -256], 0, {height: 44, pitch: 6})},
  statue: {map: ISLAND, bar: 28, frames: 248, floor: DOCK, light: 'dock', crab: 'statue', zoom: [1.0, 1.1],
    camera: low([-4761, 10431, -256], -54.07, {height: 34, pitch: 8.2})},
  // ---- the work: postcards from the maps
  unatco: postcard('01_NYC_UNATCOHQ', [-1985, 813, 608], 198, 'cross', 'indoor', {bar: 32, live: true, settle: 4}),     // live: the trooper at the desk breathes
  switch: postcard('00_Training', [-1149, 826, -80], 0, 'skid', 'indoor', {bar: 34}),
  street: postcard('02_NYC_Street', [2200, -390, -1136], 307.8, 'cross_back', 'station', {bar: 36, live: true, frames: 125}),     // these two bars round to 125 frames
  market: postcard('06_HongKong_WanChai_Market', [-469, -118, 48], 0, 'approach', 'market', {bar: 38}),
  'it-runs': {map: '02_NYC_Street', bar: 48, frames: 249, floor: -1179.5, light: 'station', crab: 'it_runs', live: true, linear: true,
    camera: {track: [[0, low([2200, -390, -1136], 307.8, {height: 40, pitch: 3}).at, low([2200, -390, -1136], 307.8, {height: 40, pitch: 3}).to],
      [8.3, low([2200, -390, -1136], 307.8, {height: 40, pitch: 3, ahead: 230}).at, low([2200, -390, -1136], 307.8, {height: 40, pitch: 3, ahead: 230}).to]]}},
  // four places of the campaign, half a bar each, the level running (chosen 2026-11-11 from the maps' starts: the first four were too dark to read)
  'maps-1': postcard('06_HongKong_WanChai_Street', [-2.3, 614.7, 47.8], 269.3, 'gaze_up', 'market', {bar: 52, frames: 62, into: 'maps', offset: 0, live: true, settle: 3, view: {height: 34, pitch: 9}}),
  'maps-2': postcard('10_Paris_Catacombs', [-3134.2, 3731.5, 2095.8], 180, 'cross', 'dock', {bar: 53, frames: 62, into: 'maps', offset: 62, live: true, settle: 3, gain: 0.8}),
  'maps-3': postcard('12_Vandenberg_Gas', [2558.9, -2101.6, -1516.2], 1.8, 'arrive', 'dock', {bar: 54, frames: 62, into: 'maps', offset: 124, live: true, settle: 3, gain: 0.6}),
  'maps-4': postcard('15_Area51_Final', [-5204.5, -2177, -1392.2], 269.96, 'gaze_up', 'indoor', {bar: 55, frames: 62, into: 'maps', offset: 186, live: true, settle: 3, gain: 0.7}),
  // ---- denton: the dock at night
  dock: {map: ISLAND, bar: 56, frames: 124, floor: DOCK, light: 'dock', crab: 'dock', zoom: [1.0, 1.06],
    camera: {at: [-4610, 10452, -266], to: [-4705, 10386, -284]}},
  'jc-a': {map: ISLAND, bar: 58, frames: 124, floor: DOCK, light: 'dock', crab: 'jc_a', zoom: [1.0, 1.07], into: 'jc', offset: 0,
    camera: {at: [-4790, 10405, -275], to: [-4560, 10431, -250]},
    actors: [{cls: JC, at: [-4550, 10431, -256.2], yaw: 180, anim: 'BreatheLight', cycle: 3.2, frame: 0.1}]},
  'jc-b': {map: ISLAND, bar: 60, frames: 124, floor: DOCK, light: 'dock', crab: 'jc_b', zoom: [1.0, 1.08], into: 'jc', offset: 124,
    camera: {at: [-4480, 10520, -208], to: [-4703, 10406, -282]},
    actors: [{cls: JC, at: [-4550, 10431, -256.2], yaw: 180, anim: 'BreatheLight', cycle: 3.2, frame: 0.4}]},
  turn: {map: ISLAND, bar: 62, frames: 124, floor: DOCK, light: 'dock', crab: 'turn', zoom: [1.0, 1.1],     // from the front: the two of them, and the shades
    camera: {at: [-4428, 10414, -269], to: [-4560, 10421, -254]},
    actors: [{cls: JC, at: [-4550, 10445, -256.2], yaw: 0, anim: 'BreatheLight', cycle: 3.2, frame: 0.6}]},
  // ---- finale: a walk along the dock, the camera backing away in front of them
  together: {map: ISLAND, bar: 64, frames: 249, floor: DOCK, light: 'dock', crab: 'together', linear: true,
    camera: {track: [[0, [WALK.from[0] + 185, WALK.from[1] + 105, DOCK + 36], [WALK.from[0] - 10, WALK.from[1] + 22, DOCK + 50]],
      [8.3, [WALK.to[0] + 185, WALK.to[1] + 105, DOCK + 36], [WALK.to[0] - 10, WALK.to[1] + 22, DOCK + 50]]]},
    actors: [{cls: JC, at: [WALK.from[0], WALK.from[1], -256.2], yaw: 0, anim: 'Walk', cycle: 1.05, frame: 0, path: [[0, ...WALK.from], [8.3, ...WALK.to]]}]},
};
