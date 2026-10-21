/** The markdown tables of docs/input-bindings.md from a run's JSON (browser-tests/input-bindings-table.spec.mjs writes it to DX_TABLE_OUT,
 * scripts/validate-input-bindings.mjs to --table):
 *   node scripts/input-bindings-table.mjs <table.json>                   prints the tables
 *   node scripts/input-bindings-table.mjs <table.json> docs/input-bindings.md   replaces what is between the doc's TABLE markers */
import { readFile, writeFile } from 'node:fs/promises';
import { readBindingRows } from './input-binding-cases.mjs';

const rows = JSON.parse(await readFile(process.argv[2], 'utf8'));
const { aliases } = await readBindingRows();
const expand = binding => aliases.find(entry => entry.alias.toLowerCase() === binding.toLowerCase())?.command;
const pointer = { LeftMouse: 'left button', RightMouse: 'right button', MiddleMouse: 'middle button', MouseX: 'pointer motion (relative, locked)', MouseY: 'pointer motion (relative, locked)',
  MouseWheelUp: 'wheel up', MouseWheelDown: 'wheel down' };
// Keys a browser takes for itself before or besides the page (docs/input-bindings.md "Browser-reserved keys"): Keyboard Lock delivers them in fullscreen.
const LOCKED = new Set(['F1', 'F3', 'F5', 'F6', 'F7', 'F10', 'F11', 'F12', 'Tab']);
const cell = text => String(text ?? '').replace(/\|/g, '\\|');
const out = [];
out.push('| Key | Binding | Browser input | Window | Fullscreen | In Play |', '| --- | --- | --- | --- | --- | --- |');
let bound = 0, effects = 0, boundaries = 0;
for (const row of rows) {
  if (row.joy || !row.binding) continue;
  bound++;
  const input = pointer[row.key] ?? (row.codes.length ? row.codes.map(code => `\`${code}\``).join(', ') : 'none');
  const window = row.key === 'Escape' ? 'yes (1)' : row.key === 'F11' ? 'yes (2)' : pointer[row.key] ? 'yes' : row.codes.length ? 'yes' : 'no';
  const fullscreen = row.key === 'Escape' ? 'yes, locked (1)' : row.key === 'F11' ? 'yes, locked (2)' : LOCKED.has(row.key) ? 'yes, locked' : pointer[row.key] ? 'yes' : row.codes.length ? 'yes' : 'no';
  const command = expand(row.binding);
  const binding = `\`${row.binding}\`${row.scriptBound ? ' (3)' : ''}${command ? ` = \`${command}\`` : ''}`;
  let play;
  if (row.status === 'boundary') { boundaries++; play = `delivered; stops at ${row.boundary}. ${row.effect}`; }
  else { effects++; play = row.effect; }
  if (row.windowEffect) play += `. In a window: ${row.windowEffect}`;
  out.push(`| ${cell(row.key)} | ${cell(binding)} | ${cell(input)} | ${window} | ${fullscreen} | ${cell(play)} |`);
}
out.push('');
out.push(`${bound} bound lines (${effects} with an observed effect, ${boundaries} delivered and stopping at a later stage's system). Unbound lines of [Engine.Input]:`, '');
out.push('| Key | Browser input | In Play |', '| --- | --- | --- |');
for (const row of rows) {
  if (row.joy || row.binding) continue;
  const input = pointer[row.key] ?? (row.codes.length ? row.codes.map(code => `\`${code}\``).join(', ') : 'none');
  out.push(`| ${row.key} | ${input} | ${row.codes.length ? (row.effect ?? 'not pressed') : 'no browser key or button'} |`);
}
const joy = rows.filter(row => row.joy);
out.push('', `${joy.length} Joy* lines (${joy.filter(row => row.binding).map(row => `${row.key}=${row.binding}`).join(', ')}) have no browser device in this page: a gamepad is not read.`);
const markdown = out.join('\n');
if (process.argv[3]) {
  const doc = await readFile(process.argv[3], 'utf8');
  const start = doc.indexOf('<!-- TABLE -->'), end = doc.indexOf('<!-- /TABLE -->');
  if (start < 0 || end < start) throw new Error('the doc has no TABLE markers');
  await writeFile(process.argv[3], `${doc.slice(0, start)}<!-- TABLE -->\n${markdown}\n${doc.slice(end)}`);
} else console.log(markdown);
