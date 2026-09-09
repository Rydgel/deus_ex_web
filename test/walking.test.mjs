import test from 'node:test';
import assert from 'node:assert/strict';
import {walkingCases,run} from '../scripts/validate-native-walking.mjs';
const cases=walkingCases();
const expectations=[
{"i":0,"state":{"position":[1.1904001235961914,0,45],"velocity":[74.4000015258789,0,0],"physics":1,"hitSlopedWall":false},"order":["prelude","move","line"]},
{"i":2,"state":{"position":[2.911134719848633,0,45],"velocity":[29.111347198486328,0,0],"physics":1,"hitSlopedWall":false},"order":["prelude","move","line","move","line","move","line"]},
{"i":10,"state":{"position":[1.1904001235961914,0,45],"velocity":[74.4000015258789,0,0],"physics":2,"hitSlopedWall":false},"order":["prelude","move","line","MayFall","Falling","physics"]},
{"i":11,"state":{"position":[1.4555673599243164,0,45],"velocity":[29.111347198486328,0,0],"physics":2,"hitSlopedWall":false},"order":["prelude","move","line","MayFall","Falling","physics","falling"]},
{"i":13,"state":{"position":[1.1904001235961914,0,46.099998474121094],"velocity":[74.4000015258789,0,0],"physics":1,"hitSlopedWall":false},"order":["prelude","move","line","move"]},
{"i":14,"state":{"position":[1.1904001235961914,0,45],"velocity":[74.4000015258789,0,0],"physics":1,"hitSlopedWall":false},"order":["prelude","line","line","line","line","move","line"]},
{"i":15,"state":{"position":[0,0,45],"velocity":[0,0,0],"physics":1,"hitSlopedWall":false},"order":["prelude","move","line","MayFall","farMove"]},
{"i":16,"state":{"position":[0.5208000540733337,0,45],"velocity":[74.4000015258789,0,0],"physics":2,"hitSlopedWall":false},"order":["prelude","move","move","move","wall","move","move","Falling"]},
{"i":17,"state":{"position":[1.3824000358581543,0,45],"velocity":[74.4000015258789,0,0],"physics":1,"hitSlopedWall":false},"order":["prelude","move","line"]},
{"i":26,"state":{"position":[0,0,45],"velocity":[0,0,0],"physics":1,"hitSlopedWall":false},"order":["prelude","line"]},
{"i":35,"state":{"position":[1.7064961194992065,0,44.91244888305664],"velocity":[106.656005859375,0,0],"physics":1,"hitSlopedWall":false},"order":["prelude","move","line","move"]},
{"i":42,"state":{"position":[131.50570678710938,-75.10069274902344,102],"velocity":[70.93704223632812,-187.66693115234375,0],"physics":1,"hitSlopedWall":false},"order":["prelude","move","line","move","line","move","line"]}
];
test('dry walking native state and call order regressions',()=>{
 for(const {i,state,order} of expectations){const r=run(cases[i]);assert.deepEqual({position:r.position,velocity:r.velocity,physics:r.physics,hitSlopedWall:r.hitSlopedWall},state,`native case ${i}`);assert.deepEqual(r.events.map(e=>e.event??Object.keys(e)[0]),order);}
});
