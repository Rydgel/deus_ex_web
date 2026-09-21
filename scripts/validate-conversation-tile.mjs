import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {gameDirectory} from './game-directory.mjs';
import {layoutTileDown} from '../src/runtime/script-window-tile.mjs';
const samples=[{width:800,heights:[18,1,38]},{width:361.5,heights:[18.25,1,72.5]},
 {width:240,heights:[]},{width:300,heights:[22,1,58,90]}];
const native=JSON.parse(execFileSync(process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',
 ['scripts/native-conversation-tile-oracle.py'],{input:JSON.stringify({gameRoot:gameDirectory(),samples}),encoding:'utf8'}));
for(let i=0;i<samples.length;i++){
 const actual=layoutTileDown(samples[i].width,samples[i].heights);
 assert.equal(actual.height,native[i].height);
 assert.deepEqual(actual.rects.map(r=>[r.x,r.y,r.width,r.height]),native[i].rects);
 assert.ok(native[i].queryWidths.every(w=>w===actual.innerWidth));
}
console.log('4 original TileWindow preferred-size/configuration cases passed.');
