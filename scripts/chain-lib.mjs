/** Shared pieces of the Stage 6 chain harness (docs/stage-6-chains.md): the step vocabulary's data helpers, the flag and snapshot formats, and the
 * comparison of a Play run with an original capture. The two drivers (scripts/chain-play.mjs in Play, scripts/chain-original.mjs under Wine) read the
 * same chain files (scripts/chains/mission*.mjs) and write the same result shape:
 *
 *   { mission, snaps: { <label>: { map, flags: ['name|type|expiration|value', ...], defaultExpiration } },
 *     legs: [ { label, from, to, text } ]        (the travel text each map change exported, as the original's dump-travel-win reads it back)
 *     steps: [ 'text of what each step did' ] }
 *
 * A chain is a list of steps; every step has an `op` and, optionally, a `note` (why it is there) and `harness: true` when it is a labelled harness step (a
 * placement or a cheat line, not the player's own input). The ops:
 *
 *   start    { kind: 'menu-training' | 'new-game', ... }   the run's start: the menu's Training button, or New Game (the intro left by Escape)
 *   wait     { seconds } | { flag } | { map } | { notFlag }  Level time in Play, real time under Wine, or until the condition (with `timeout`)
 *   line     { text }                                       one console line, typed as the original's console takes it (an exec function or a cheat)
 *   place    { at: [x, y, z], view: [pitch, yaw], harness, drop }  `ghost`, `set Location`, `walk`, `set ViewRotation`: the player put at the approach (`drop`: above a cylinder the fall enters, the view set first)
 *   frob     {}                                             the right mouse button (ParseRightClick): use, pick up, open
 *   click    {}                                             the left mouse button / Enter (ParseLeftClick|Fire): use the tool in hand, fire
 *   belt     { n }                                          ActivateBelt n
 *   key      { names: ['ENTER', ...] }                      key presses (dxinput names), each press and release
 *   conv     { name, choose: [{ label, index }] }           a conversation started by the owner or its trigger, played with Enter, the listed choices picked by their order
 *   travel   { to, via }                                    the map change a step caused (the arrival is awaited and the leg's travel text recorded)
 *   snap     { label }                                      the flags (and the map) at this point
 */
import { readFile } from 'node:fs/promises';

/** The chain's key names (dxinput.c's) and Play's KeyboardEvent codes. */
export const PLAY_KEY = Object.freeze({
  ENTER: 'Enter', ESC: 'Escape', UP: 'ArrowUp', DOWN: 'ArrowDown', LEFT: 'ArrowLeft', RIGHT: 'ArrowRight', TAB: 'Tab', SPACE: 'Space',
  ...Object.fromEntries([...'0123456789'].map(d => [d, `Digit${d}`])), ...Object.fromEntries([...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map(l => [l, `Key${l}`])),
});

/** The console lines of a `place` step: what the original's capture types (docs/stage-5-exit-criteria.md "Conversation captures": ghost, a SET of Location, walk, a SET of ViewRotation). */
export function placeLines({ at, view, drop = false }) {
  const location = `set DeusEx.JCDentonMale Location (X=${at[0]},Y=${at[1]},Z=${at[2]})`, rotation = `set DeusEx.JCDentonMale ViewRotation (Pitch=${view[0]},Yaw=${view[1]},Roll=0)`;
  // a `drop` (the fall into a Teleporter's or an exit's cylinder ends the level) turns the view first and makes `walk`, which starts the fall, the last line
  return drop ? ['ghost', rotation, location, 'walk'] : ['ghost', location, 'walk', rotation];
}

/** `name|type|expiration|value` of a flag, as the transitions validator compares them. */
export const flagString = (name, type, expiration, value) => `${name}|${type}|${expiration}|${value | 0}`;

/** The flags tools/dump-flags-win.c printed. */
export function flagsOfDump(text) {
  const lines = String(text).split(/\r?\n/);
  const header = /defaultExpiration (\d+)/.exec(lines[0]);
  const flags = [];
  for (const line of lines) {
    const m = /^\s+flag (\S+) type (\d+) expiration (-?\d+) value (0x[0-9a-f]+)/.exec(line);
    if (m) flags.push(flagString(m[1], Number(m[2]), Number(m[3]), parseInt(m[4], 16)));
  }
  return { flags: flags.sort(), defaultExpiration: header ? Number(header[1]) : null };
}

/** Play's flag store as the same strings. */
export function flagsOfPlay(c) {
  const store = c.read(c.player(), 'FlagBase');
  return { flags: [...(store?.entries?.values() ?? [])].map(e => flagString(e.name, e.type, e.expiration, e.value)).sort(), defaultExpiration: store?.defaultExpiration ?? null };
}

/** Flags that the comparison leaves out: none yet (every flag of the store is compared). */
export const IGNORED_FLAGS = Object.freeze([]);

/** The first differences between two flag lists: { onlyPlay, onlyOriginal } (names with their values). */
export function flagDifferences(play, original) {
  const a = new Set(play), b = new Set(original);
  return { onlyPlay: play.filter(f => !b.has(f)), onlyOriginal: original.filter(f => !a.has(f)) };
}

export async function loadChain(mission) {
  const module = await import(new URL(`./chains/mission${mission}.mjs`, import.meta.url).href);
  return module.default;
}

export const captureDirectory = mission => new URL(`../.work/chains/m${mission}/`, import.meta.url).pathname;

export async function readIfExists(path) { try { return await readFile(path, 'utf8'); } catch { return null; } }
