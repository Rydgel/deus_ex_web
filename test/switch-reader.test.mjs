import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const module = fileURLToPath(new URL('../src/runtime/switch-reader.mjs', import.meta.url));

// Each scenario runs in a child process: the module decides at its load whether it runs in Node (full read at each call) or in a
// browser realm (no `process`: the first answer is kept), and reads SWITCH_CACHE from the environment of the child.
const run = (code, env = {}) => execFileSync(process.execPath, ['--input-type=module', '-e', code], {
  env: {PATH: process.env.PATH, ...env}, encoding: 'utf8',
}).trim();

test('Node reads the environment at every call, as the readers it replaces did', () => {
  const out = run(`
    const {switchReader} = await import(${JSON.stringify(module)});
    const read = switchReader('ZZ_SWITCH', 'DEUS_EX_ZZ_SWITCH', 'fallback');
    const seen = [read()];
    process.env.ZZ_SWITCH = 'env';
    seen.push(read());
    delete process.env.ZZ_SWITCH;
    globalThis.DEUS_EX_ZZ_SWITCH = 'page';
    seen.push(read());
    console.log(seen.join());`);
  assert.equal(out, 'fallback,env,page');
});

test('a browser realm reads its switch once, at the first call, after the page has set it', () => {
  const out = run(`
    delete globalThis.process;
    const {switchReader} = await import(${JSON.stringify(module)});
    const read = switchReader('ZZ_SWITCH', 'DEUS_EX_ZZ_SWITCH', 'fallback');
    globalThis.DEUS_EX_ZZ_SWITCH = 'js';
    const first = read();
    globalThis.DEUS_EX_ZZ_SWITCH = 'later';
    console.log([first, read(), read()].join());`);
  assert.equal(out, 'js,js,js');
});

test('?switchCache=js keeps the full read at every call in a browser realm', () => {
  const out = run(`
    delete globalThis.process;
    globalThis.DEUS_EX_SWITCH_CACHE = 'js';
    const {switchReader} = await import(${JSON.stringify(module)});
    const read = switchReader('ZZ_SWITCH', 'DEUS_EX_ZZ_SWITCH', 'fallback');
    const seen = [read()];
    globalThis.DEUS_EX_ZZ_SWITCH = 'later';
    seen.push(read());
    console.log(seen.join());`);
  assert.equal(out, 'fallback,later');
});

test('SWITCH_CACHE=verify keeps the first answer and throws when the full read differs', () => {
  const out = run(`
    const {switchReader} = await import(${JSON.stringify(module)});
    const read = switchReader('ZZ_SWITCH', 'DEUS_EX_ZZ_SWITCH', 'fallback');
    const first = [read(), read()];
    process.env.ZZ_SWITCH = 'changed';
    let caught = 'no error';
    try { read(); } catch (error) { caught = error.message.slice(0, 40); }
    console.log(first.join() + '|' + caught);`, {SWITCH_CACHE: 'verify'});
  assert.equal(out, 'fallback,fallback|SWITCH_CACHE=verify: DEUS_EX_ZZ_SWITCH w');
});

test('SWITCH_CACHE=on makes Node keep the first answer too', () => {
  const out = run(`
    const {switchReader} = await import(${JSON.stringify(module)});
    const read = switchReader('ZZ_SWITCH', 'DEUS_EX_ZZ_SWITCH', 'fallback');
    const first = read();
    process.env.ZZ_SWITCH = 'changed';
    console.log(first + ',' + read());`, {SWITCH_CACHE: 'on'});
  assert.equal(out, 'fallback,fallback');
});
