/** Scenarios for the original UEventManager (scripts/native-event-manager-oracle.py) and the Rust port
 * (native/script-vm/src/aievent.rs, scripts/validate-event-manager.mjs). One scenario is a set of actors and a list of
 * operations; the oracle runs them over the original instructions and the validator over the Rust exports, and both
 * report each operation's boundary log and the manager's tables. */
import {aiNameHash} from '../src/runtime/script-vm-aievent.mjs';

const cases = [];
const add = (name, actors, ops) => cases.push({name, actors, ops});
const pawn = (x, y = 0, z = 0, extra = {}) => ({kind: 'pawn', location: [x, y, z], hearing: 0.1, lastRender: 100, distance: 500, ...extra});
const plain = (x, y = 0, z = 0, extra = {}) => ({kind: 'plain', location: [x, y, z], ...extra});
const callback = (receiver, event, extra = {}) => ({op: 'setCallback', receiver, event, callback: `Handle${event}`, ...extra});
const send = (sender, event, type = 1, value = 1, radius = 800) => ({op: 'send', sender, event, type, value, radius});
const start = (sender, event, type = 1, value = 1, radius = 800) => ({op: 'start', sender, event, type, value, radius});
const process = {op: 'process'};
const time = seconds => ({op: 'time', seconds});
const repeat = (n, op) => Array.from({length: n}, () => op);

add('loud-noise-pulse', {R: pawn(0), S: pawn(300)}, [
  time(100.5), callback('R', 'LoudNoise', {score: 'LoudNoiseScore'}), send('S', 'LoudNoise'), process, process, {op: 'cleanup'}]);

add('persistent-begin-end', {R: pawn(0), S: pawn(250)}, [
  time(100.5), callback('R', 'Distress', {score: 'DistressScore'}), start('S', 'Distress', 1, 2, 1000), process, process, process,
  {op: 'end', sender: 'S', event: 'Distress', type: 1}, process, process, {op: 'tick'}, {op: 'tick'}]);

add('change-best', {R: pawn(0), A: pawn(300), B: pawn(600), C: pawn(-450, 100)}, [
  time(100.5), callback('R', 'Alarm'), start('B', 'Alarm', 1, 3, 2000), start('A', 'Alarm', 1, 3, 2000), start('C', 'Alarm', 1, 3, 2000), process, process,
  {op: 'end', sender: 'A', event: 'Alarm', type: 1}, process, process, {op: 'end', sender: 'C', event: 'Alarm', type: 1}, process, process,
  {op: 'end', sender: 'B', event: 'Alarm', type: 1}, process, process, {op: 'tick'}]);

add('visual-futz-can-see', {R: pawn(0), S: pawn(500, 100)}, [
  time(100.5), callback('R', 'Futz', {flags: [1, 1, 0, 1]}), send('S', 'Futz', 0, 1), process, process,
  {op: 'policy', policy: {canSee: [['R', 'S', 0]]}}, send('S', 'Futz', 0, 1), process,
  {op: 'policy', policy: {canSee: [['R', 'S', 0.4]]}}, send('S', 'Futz', 0, 1.5), process, process]);

add('visual-flags-and-scale', {R: pawn(0), S: pawn(500, 100)}, [
  time(100.5), callback('R', 'MegaFutz', {callback: 'HandleHacking', flags: [0, 1, 1, 0]}), send('S', 'MegaFutz', 0, 0.8), process,
  callback('R', 'MegaFutz', {callback: 'HandleHacking', flags: [1, 0, 1, 1]}), send('S', 'MegaFutz', 0, 0.8), process]);

add('non-pawn-receiver-line-check-and-radius', {T: plain(0, 0, 0, {distance: 100}), A: pawn(300), B: pawn(0, 700)}, [
  time(100.5), callback('T', 'Alarm'), callback('T', 'Futz'),
  start('A', 'Alarm', 1, 2, 400), start('B', 'Alarm', 1, 2, 400), process, process,
  send('A', 'Futz', 0, 1), process, {op: 'policy', policy: {blocked: [['T', 'A']]}}, send('A', 'Futz', 0, 1), process,
  {op: 'end', sender: 'A', event: 'Alarm', type: 1}, {op: 'end', sender: 'B', event: 'Alarm', type: 1}, process, process, {op: 'tick'}]);

add('smell-and-ignored-types', {R: pawn(0), S: pawn(100)}, [
  time(100.5), callback('R', 'Scent'), send('S', 'Scent', 2, 1, 0), process, process,
  {op: 'set', actor: 'S', fields: {location: [5000, 0, 0]}}, send('S', 'Scent', 7, 1, 100), process]);

add('inventory-sender-owner-scale', {R: pawn(0), W: {kind: 'inventory', location: [400, 0, 0], radius: 8, height: 4, owner: 'O'},
  O: pawn(400, 0, 0, {radius: 17, height: 39}), N: {kind: 'inventory', location: [300, 100, 0], radius: 8, height: 4}}, [
  time(100.5), callback('R', 'WeaponDrawn', {score: 'WeaponDrawnScore'}), start('W', 'WeaponDrawn', 0, 1), process, process,
  {op: 'end', sender: 'W', event: 'WeaponDrawn', type: 0}, start('N', 'WeaponDrawn', 0, 1), process, process,
  {op: 'set', actor: 'O', fields: {radius: 0}}, {op: 'end', sender: 'N', event: 'WeaponDrawn', type: 0}, start('W', 'WeaponDrawn', 0, 1), process, process]);

add('stasis-and-render-culling', {R: pawn(0, 0, 0, {stasis: true}), N: pawn(0, 0, 0, {lastRender: 50, distance: 4000}), F: pawn(0, 0, 0, {lastRender: 99.5, distance: 4000}),
  P: pawn(0, 0, 0, {lastRender: 50, distance: 1000}), S: pawn(350, 0, 0), L: pawn(500, 0, 0)}, [
  time(100.5), callback('R', 'LoudNoise'), callback('N', 'LoudNoise'), callback('F', 'LoudNoise'), callback('P', 'LoudNoise'),
  start('S', 'LoudNoise', 1, 3, 5000), start('L', 'LoudNoise', 1, 3, 5000), process, process,
  {op: 'set', actor: 'R', fields: {stasis: false, lastRender: 60, distance: 5000}}, {op: 'end', sender: 'S', event: 'LoudNoise', type: 1}, process, process]);

add('deleted-sender-and-receiver', {R: pawn(0), S: pawn(100), D: pawn(200)}, [
  time(100.5), callback('R', 'Alarm'), callback('D', 'Alarm'), {op: 'set', actor: 'S', fields: {deleted: true}}, start('S', 'Alarm', 1, 5, 1000), process, process,
  {op: 'set', actor: 'S', fields: {deleted: false}}, start('S', 'Alarm', 1, 5, 1000), {op: 'set', actor: 'D', fields: {deleted: true}}, process, process, {op: 'tick'}, {op: 'tick'}]);

add('destroy-actor-and-cleanup', {R: pawn(0), S: pawn(200), T: pawn(-200)}, [
  time(100.5), callback('R', 'Distress'), callback('S', 'Distress'), callback('T', 'Distress'), callback('R', 'Alarm'),
  start('S', 'Distress', 1, 2, 900), start('T', 'Alarm', 1, 2, 900), process, process,
  {op: 'destroyActor', actor: 'S'}, process, {op: 'cleanup'}, process, {op: 'destroyActor', actor: 'R'}, {op: 'tick'}, {op: 'tick'}, {op: 'destroyActor', actor: 'T'}, {op: 'tick'}]);

add('clear-callback-and-ring', {A: pawn(0), B: pawn(100), C: pawn(200), D: pawn(300), E: pawn(400)}, [
  time(100.5), callback('A', 'LoudNoise'), callback('B', 'LoudNoise'), callback('C', 'Alarm'), callback('D', 'LoudNoise'), callback('E', 'Alarm'),
  {op: 'clearCallback', receiver: 'B', event: 'LoudNoise'}, callback('B', 'LoudNoise', {callback: 'HandleLoudNoise2'}), {op: 'clearCallback', receiver: 'A', event: 'LoudNoise'},
  {op: 'clearCallback', receiver: 'A', event: 'Missing'}, {op: 'cleanup'}, process, {op: 'cleanup'}, {op: 'clearCallback', receiver: 'D', event: 'LoudNoise'},
  {op: 'clearCallback', receiver: 'E', event: 'Alarm'}, {op: 'tick'}, callback('A', 'Alarm'), {op: 'tick'}]);

add('slot-pipeline-and-sender-gc', {R: pawn(0), S: pawn(200), U: pawn(300)}, [
  time(100.5), callback('R', 'LoudNoise'), send('S', 'LoudNoise', 1, 2, 800), send('S', 'LoudNoise', 1, 1, 900), send('U', 'LoudNoise', 0, 1, 900),
  ...Array.from({length: 20}, () => [{op: 'tick'}]).flat()]);

add('several-sends-per-slot-max-and-clear', {R: pawn(0), S: pawn(200)}, [
  time(100.5), callback('R', 'LoudNoise'), send('S', 'LoudNoise', 1, 0.3, 500), send('S', 'LoudNoise', 1, 0.9, 300), send('S', 'LoudNoise', 1, 0.5, 800),
  start('S', 'LoudNoise', 0, 0.6), start('S', 'LoudNoise', 2, 0.7), {op: 'clear', sender: 'S', event: 'LoudNoise'}, process, process,
  start('S', 'LoudNoise', 1, 0.4, 700), {op: 'end', sender: 'S', event: 'LoudNoise', type: 1}, process, {op: 'clear', sender: 'Nobody', event: 'LoudNoise'}].filter(op => !op.sender || op.sender !== 'Nobody'));

// Event names that fall in one hash bucket (a sorted insertion), and a larger set of names.
const buckets = new Map();
const collisions = [];
for (let i = 0; collisions.length < 3 && i < 100000; i++) {
  const name = `Ev${i}`, bucket = aiNameHash(name) & 255;
  if (buckets.has(bucket)) { if (!collisions.length) collisions.push(buckets.get(bucket)); collisions.push(name); } else buckets.set(bucket, name);
}
add('hash-bucket-order', {R: pawn(0), S: pawn(200)}, [
  time(100.5),
  ...[...collisions].reverse().flatMap(name => [callback('R', name), send('S', name, 1, 1, 800)]),
  ...['LoudNoise', 'WeaponFire', 'Distress', 'Alarm', 'Futz', 'MegaFutz', 'WeaponDrawn', 'Projectile', 'Carcass', 'Injury', 'alarm', 'FUTZ'].flatMap(name => [callback('R', name), send('S', name, 1, 1, 800)]),
  process, process, {op: 'tick'}, {op: 'tick'}]);

add('hearing-threshold-and-radius', {R: pawn(0, 0, 0, {hearing: 0.4}), Q: pawn(0, 0, 0, {hearing: 0}), S: pawn(500, 0, 300), V: plain(100), U: pawn(10, 0, 0, {detectable: false})}, [
  time(100.5), callback('R', 'LoudNoise'), callback('Q', 'LoudNoise'), start('S', 'LoudNoise', 1, 1, 800), process, process,
  {op: 'end', sender: 'S', event: 'LoudNoise', type: 1}, start('V', 'LoudNoise', 1, 0.2, 0), process, process, {op: 'end', sender: 'V', event: 'LoudNoise', type: 1},
  start('U', 'LoudNoise', 1, 1, 800), process, process]);

// Seeded random scenarios: many pawns and events, odd floats, every operation, to meet the x87 rounding of the distance, score,
// hearing and visibility arithmetic on values a hand-written case would not choose.
{
  let seed = 0x2545f491;
  const random = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
  const pick = list => list[Math.floor(random() * list.length)];
  const around = (scale) => Math.fround((random() - 0.5) * 2 * scale + random() * 0.01);
  const events = ['LoudNoise', 'Alarm', 'Distress', 'Futz', 'WeaponFire'];
  for (let k = 0; k < 80; k++) {
    const names = Array.from({length: 4 + Math.floor(random() * 5)}, (_, i) => `A${i}`);
    const actors = {};
    for (const name of names) {
      const kind = random() < 0.15 ? 'inventory' : random() < 0.2 ? 'plain' : 'pawn';
      actors[name] = {kind, location: [around(900), around(900), around(200)], radius: Math.fround(4 + random() * 30), height: Math.fround(4 + random() * 50),
        hearing: random() < 0.5 ? 0 : Math.fround(random() * 0.6), lastRender: Math.fround(90 + random() * 10), distance: Math.fround(random() * 3000),
        stasis: random() < 0.25, detectable: random() < 0.9, ...(kind === 'inventory' && random() < 0.7 ? {owner: pick(names)} : {})};
    }
    const ops = [time(100.5 + random())];
    for (let step = 0; step < 36; step++) {
      const roll = random(), actor = pick(names), event = pick(events);
      if (roll < 0.22) ops.push(callback(actor, event, {score: random() < 0.5 ? `${event}Score` : undefined, flags: [random() < 0.7 ? 1 : 0, random() < 0.7 ? 1 : 0, random() < 0.3 ? 1 : 0, random() < 0.7 ? 1 : 0]}));
      else if (roll < 0.32) ops.push({op: 'clearCallback', receiver: actor, event});
      else if (roll < 0.47) ops.push(send(actor, event, pick([0, 1, 1, 2]), Math.fround(random() * 3), Math.fround(random() * 1500)));
      else if (roll < 0.57) ops.push(start(actor, event, pick([0, 1, 1, 2]), Math.fround(random() * 3), Math.fround(random() * 1500)));
      else if (roll < 0.62) ops.push({op: 'end', sender: actor, event, type: pick([0, 1, 2])});
      else if (roll < 0.65) ops.push({op: 'clear', sender: actor, event});
      else if (roll < 0.67) ops.push({op: 'destroyActor', actor});
      else if (roll < 0.70) ops.push({op: 'set', actor, fields: {location: [around(900), around(900), around(200)], stasis: random() < 0.3, deleted: random() < 0.1}});
      else if (roll < 0.72) ops.push({op: 'policy', policy: {canSeeScale: Math.fround(random()), scoreScale: Math.fround(random() * 2)}});
      else if (roll < 0.80) ops.push({op: 'cleanup'});
      else ops.push(random() < 0.5 ? process : {op: 'tick'});
    }
    ops.push({op: 'tick'}, {op: 'tick'});
    add(`fuzz-${k}`, actors, ops.map(op => op.score === undefined && 'score' in op ? Object.fromEntries(Object.entries(op).filter(([key]) => key !== 'score')) : op));
  }
}

add('comparator', {}, [{op: 'qsortCompare', scores: [3, 1, 2, 2, 1.5, 0.5, 2]}]);

export {cases};
