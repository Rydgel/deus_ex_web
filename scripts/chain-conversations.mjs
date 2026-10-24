/** The conversation lists' random speeches, for the chain comparison (docs/stage-6-chains.md "Random speeches"): a conversation with a `ConEventRandomLabel` picks one of its
 * alternatives by the game's random stream (Rand), which a run under Wine and a run in Play do not share. The history a player exports holds the speech that was said, so two
 * runs of the same chain can differ in exactly that line (and its soundID). `randomSpeechSets()` returns, per conversation with a RandomLabel, the texts of all its speech
 * events: two history events whose speeches fall in one set are the same conversation's alternatives, and the comparison accepts the pair (and only that pair). */
import { readdir, readFile } from 'node:fs/promises';
import { gameDirectory } from './game-directory.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { normalizeTravelText } from '../src/runtime/travel-text.mjs';

let cached = null;
const squash = text => String(text).replace(/\s+/g, ' ').trim();
export async function randomSpeechSets() {
  if (cached) return cached;
  const root = gameDirectory(), files = [];
  for (const directory of ['System'])
    for (const name of await readdir(`${root}/${directory}`)) files.push({ path: `${directory}/${name}`, read: () => readFile(`${root}/${directory}/${name}`) });
  const assets = new AssetStore(files);
  const { readObject } = await import('../src/unreal/objects.mjs');
  const ctx = await assets.get('DeusExConText');
  const values = i => Object.fromEntries(Object.entries(readObject(ctx.pkg, ctx.bytes, i).values).map(([k, x]) => [k.toLowerCase(), x]));
  const className = i => ctx.pkg.exports[i - 1].className.replace(/^ConEvent/, '');
  const sets = [];
  for (const [path, ref] of ctx.exportsByPath) {
    if (!/^conlist_mission/.test(path)) continue;
    const list = values(ref);
    for (let item = list.conversations ?? 0, guard = 0; item && guard < 5000; guard++) {
      const it = values(item), c = values(it.conobject);
      const ids = new Set();
      let random = false;
      for (let ev = c.eventlist, k = 0; ev && k < 2000; k++) {
        const e = values(ev), kind = className(ev);
        if (kind === 'RandomLabel') random = true;
        if (kind === 'Speech' && e.conspeech) { const text = values(e.conspeech).speech; if (typeof text === 'string') ids.add(squash(text)); }
        ev = e.nextevent;
      }
      if (random && ids.size) sets.push(ids);
      item = it.next;
    }
  }
  return cached = sets;
}

/** Whether two speeches (their texts) are alternatives of one conversation's random label. */
export async function randomAlternatives(a, b) {
  a = squash(a); b = squash(b);
  if (a === b) return true;
  return (await randomSpeechSets()).some(set => set.has(a) && set.has(b));
}

/** The first difference of two travel texts (normalized, the two time properties masked), except that a conversation's random-label speech may differ: a history event whose
 * Speech and soundID differ from the original's is accepted when both speeches are alternatives of one conversation (the game's random stream is not shared by the two runs). */
export async function compareTravelTexts(expected, actual) {
  const a = normalizeTravelText(expected, { times: true }).split('\n'), b = normalizeTravelText(actual, { times: true }).split('\n');
  let excused = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    if (a[i]?.startsWith('Speech=') && b[i]?.startsWith('Speech=') && a[i + 1]?.startsWith('soundID=') && b[i + 1]?.startsWith('soundID=')
      && await randomAlternatives(a[i].slice(7), b[i].slice(7))) { excused++; i++; continue; }
    return { difference: { line: i + 1, expected: a[i] ?? null, actual: b[i] ?? null }, excused };
  }
  return { difference: null, excused };
}
