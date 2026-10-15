/** The cameras of the detail-pass validators (validate-detail-pass.mjs, validate-detail-pass-rust.mjs). */
/** Wall at Training's y = 1344 (UN_Wall_Green, DMetal_A detail), the Island pier's deck (un_dock_S, DWoodFine_A). */
export const detailJobs = [
  ['00_Training', [[-736, 560], [-1100, 560]].flatMap(([x, z]) => [8, 18, 30, 55, 85, 120, 200, 400].flatMap(d =>
    [0, 5000, -5000].map(yawOffset => ({ location: [x, 1344 - d, z], rotation: [0, 16384 + yawOffset, 0] }))))],
  ['01_NYC_UNATCOIsland', [8, 20, 40, 70, 110, 200].flatMap(height => [0, 20000, 40000].flatMap(yaw =>
    [-6000, -9000].map(pitch => ({ location: [-4761, 10431, -304 + height], rotation: [pitch + 65536, yaw, 0] }))))],
];
