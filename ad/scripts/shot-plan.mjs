// Camera plan shared by the original-game and browser-runtime captures.
// Positions are original Unreal units (Z up) for the *eye*; rotations are
// original rotator units [pitch, yaw, roll] (65536 = 360 degrees). The original
// capture places JCDentonMale at eye - (0,0,EYE_HEIGHT) in ghost mode; the
// browser capture uses the same eye through its reference-camera form.
// Actor locations come from `node scripts/export-map.mjs <map>`.
export const EYE_HEIGHT = 40;

const deg = d => Math.round(d / 360 * 65536);
const wrap = u => ((Math.round(u) % 65536) + 65536) % 65536;

// Aim from an eye position at a target point.
export function aim(eye, target) {
  const dx = target[0] - eye[0], dy = target[1] - eye[1], dz = target[2] - eye[2];
  const yaw = Math.atan2(dy, dx) * 180 / Math.PI;
  const pitch = Math.atan2(dz, Math.hypot(dx, dy)) * 180 / Math.PI;
  return [wrap(deg(pitch)), wrap(deg(yaw)), 0];
}

function look(name, eye, target, extra = {}) {
  return {name, eye, rotation: aim(eye, target), ...extra};
}

// A character portrait: the camera stands `distance` in front of the actor
// along its authored yaw (optionally swung sideways by `swing` units) at face
// height and looks at its face.
function portrait(name, location, yaw, {distance = 70, face = 36, swing = 0, rise = 2} = {}) {
  const a = wrap(yaw + swing) / 65536 * Math.PI * 2;
  const target = [location[0], location[1], location[2] + face];
  const eye = [location[0] + Math.cos(a) * distance, location[1] + Math.sin(a) * distance, target[2] + rise];
  return {name, eye, rotation: aim(eye, target)};
}

export const maps = [
  {
    map: '00_Training',
    // Views from PlayerStart before any cheat, with the original HUD. The
    // InfoLink shot nudges JC into DataLinkTrigger23 (dl_start, radius 300)
    // with a one-off Velocity, since posted keys are released by UE1's
    // GetKeyState check and cannot be held.
    start: [
      {name: 't-start', hud: true, wait: 2500},
      {name: 't-infolink', hud: true, velocity: [700, 0, 0], wait: 3200},
      {name: 't-infolink-2', hud: true, wait: 2500},
    ],
    shots: [
      {name: 't-side', eye: [-1149.24, 825.84, -40.2], rotation: [65501, 2496, 0]},
      look('t-corridor', [-980, 830, 30], [-250, 841, -60]),
      look('t-observers', [365, 1040, -38], [360, 1210, -30]),
      look('t-observers-wide', [150, 930, -10], [365, 1215, -30]),
      look('t-crates', [1030, -140, -45], [1022, -275, -70]),
      look('t-weapons', [1070, 300, -30], [1070, 378, -79]),
      look('t-medbot', [5105, -4030, 30], [5105, -4170, 4]),
      look('t-repairbot', [5078, 490, -110], [5078, 362, -144]),
      // Characters, from reports/00_Training/actors.json.
      portrait('p-jaime-observer', [361, 1206, -53], -16544, {distance: 58}),
      portrait('p-mib', [286, 1215, -44], -14960, {distance: 58}),
      portrait('p-walton', [435, 1205, -48], -17512, {distance: 58}),
      portrait('p-scientist-observer', [284, 1394, -3], -16184, {distance: 70}),
      portrait('p-jaime-lab', [1055, 717, 3], -16352, {distance: 70}),
      portrait('p-instructor', [2945, 982, -71], 47528, {distance: 48}),
      portrait('p-instructor-wide', [2945, 982, -71], 47528, {distance: 60, swing: 5000, face: 20}),
      portrait('p-trooper-body', [3652, 849, -80], 0, {distance: 80, face: 25}),
      portrait('p-doctor', [3680, 1291, 24], -16256, {distance: 70}),
      portrait('p-scientist-female', [2249, 1192, -37], -13408, {distance: 70}),
      portrait('p-doctor-2', [2323, 1196, -32], -20432, {distance: 70}),
      portrait('p-manderley', [6129, -3748, 28], -17128, {distance: 75}),
      portrait('p-manderley-wide', [6129, -3748, 28], -17128, {distance: 190, face: 25}),
      portrait('p-jaime-end', [5654, -3760, 23], -15928, {distance: 70}),
      portrait('p-trooper-end', [6227, -3747, 28], -15672, {distance: 70}),
      portrait('p-secretary', [5482, -3698, 23], 0, {distance: 70}),
      portrait('p-scientist-end', [5863, -3372, 72], 16960, {distance: 70}),
      portrait('p-trooper-pool', [4666, -4415, 25], 63912, {distance: 70}),
    ],
  },
  {
    map: '01_NYC_UNATCOHQ',
    shots: [
      portrait('h-anna', [671, 1403, 297], 19464, {distance: 66}),
      portrait('h-gunther', [633, 1505, 298], -12176, {distance: 70}),
      portrait('h-anna-gunther', [652, 1454, 297], 3644, {distance: 150, face: 30, swing: 16384}),
      portrait('h-paul', [366, 39, 288], -17008, {distance: 66}),
      portrait('h-manderley', [408, -184, 305], 30664, {distance: 70}),
      portrait('h-manderley-wide', [408, -184, 305], 30664, {distance: 170, face: 25}),
      portrait('h-alex', [2326, -695, -71], 14648, {distance: 66, face: 30}),
      portrait('h-sam', [879, -932, -16], -32456, {distance: 66}),
      portrait('h-jaime', [1168, 1068, -21], -26248, {distance: 66}),
      portrait('h-janice', [263, 537, 283], -22496, {distance: 66}),
      portrait('h-trooper', [380, 683, 288], 0, {distance: 70}),
      look('h-entrance', [-1985, 813, 640], [-1985, 300, 600]),
    ],
  },
  {
    map: '01_NYC_UNATCOIsland',
    start: [{name: 'l-start', hud: true, wait: 3500}],
    shots: [
      look('l-statue-dock', [-4600, 10200, -180], [3047, 82, 2600]),
      look('l-statue-mid', [-2400, 5200, 150], [3047, 82, 2400]),
      look('l-statue-near', [-900, 2300, 300], [3047, 82, 2600]),
      look('l-statue-water', [-6500, 1500, -150], [3047, 82, 2200]),
      look('l-statue-high', [-3000, 6000, 1400], [3047, 82, 2400]),
      look('l-boat', [-4800, 9700, -150], [-5122, 10139, -270]),
      portrait('l-paul', [-2366, 8295, -256], 18352, {distance: 66}),
      portrait('l-paul-wide', [-2366, 8295, -256], 18352, {distance: 160, face: 25}),
      portrait('l-gunther', [1880, -2234, -119], 16152, {distance: 70}),
      portrait('l-harley', [1547, -9968, -256], -14648, {distance: 66}),
      portrait('l-collins', [-1950, 10332, -250], -22024, {distance: 66}),
      portrait('l-kaplan', [-4435, 2780, -92], 24880, {distance: 66}),
      portrait('l-nsf', [-32, 5251, -88], -2608, {distance: 70}),
      portrait('l-nsf-2', [1802, 5497, -92], -32704, {distance: 80, face: 30}),
    ],
  },
  // The official in-engine opening cinematic: shoot it at a fixed interval.
  {map: '00_Intro', sequence: {prefix: 'intro', interval: 1400, count: 170}},
];
