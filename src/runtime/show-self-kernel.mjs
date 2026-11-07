/**
 * The pawn-list walk of APawn::ShowSelf in Rust (native/script-vm/src/showself.rs, docs/script-pawn-tick-visibility.md). The JavaScript
 * reference is script-pawn-perception.mjs `showPawnSelf`, which stays the body: it asks `scan(listener, player)` for the next pawn it
 * has to look at (one whose SightCounter is below zero or NaN, or whose image Rust cannot read) and reads the pawns between from the
 * images only.
 *
 * SHOW_SELF (`?showSelf=`): 'rust' (default), 'js' (the whole walk in JavaScript) or 'verify' (each answer of Rust is checked against a
 * JavaScript walk of the same pawns from the same place: the pawns it skipped are all ones the body would skip, and a pawn it
 * returns is the first the body would look at or one it cannot read).
 */
import {fieldImageCell, fieldImageCellVersion, cellKind, scalarCell} from './script-object-image.mjs';
import {handleOf, identityOfHandle} from './script-object-handles.mjs';
import {switchReader} from './switch-reader.mjs';
import {fieldKeyId} from './script-vm-lower.mjs';

export const showSelfMode = switchReader('SHOW_SELF', 'DEUS_EX_SHOW_SELF', 'rust');
const counts = {scans: 0, found: 0, ended: 0, unreadable: 0, skipped: 0, verified: 0};
(globalThis.deusExVerifyCounts ??= {}).showSelf = counts;
if (typeof process !== 'undefined' && process.env?.SHOW_SELF === 'verify')
  process.on('exit', () => process.stderr.write(`show self verify: ${JSON.stringify(counts)}\n`));

// [spelling, key, kind]: the ABI with showself.rs (SS_FIELDS).
const FIELDS = [['SightCounter', 'engine.pawn.sightcounter', 'float'], ['NextPawn', 'engine.pawn.nextpawn', 'pointer']];

export class ShowSelfHost {
  constructor(vm) {
    this.vm = vm;
    this.version = -1;
    this.valid = false;
  }
  attach(x) {
    this.x = x;
    this.fieldsAt = x.showself_fields_ptr();
  }
  table() {
    const version = fieldImageCellVersion();
    if (version === this.version) return this.valid;
    this.version = version;
    const cells = FIELDS.map(([, key, kind]) => {
      const cell = fieldImageCell(key);
      return cellKind(cell) === kind ? cell : null;
    });
    this.valid = !cells.includes(null);
    if (this.valid) {
      const view = this.vm.arena.view;
      cells.forEach((cell, i) => {
        view.setUint32(this.fieldsAt + 4 * i, cell.offset, true);
        view.setUint32(this.fieldsAt + 8 + 4 * i, fieldKeyId(FIELDS[i][1]), true);
      });
    }
    return this.valid;
  }
  /** The scan function of one walk of the player's ShowSelf, in the mode of the switch: `(listener, player) => the pawn the body has to
   * look at, null at the end of the list`; null where the whole walk stays in JavaScript. `read` is the body's own SightCounter read
   * and `next` its NextPawn read (verify mode runs the walk with them). */
  scanner(read, next) {
    const mode = showSelfMode();
    if (mode === 'js' || !this.x || !this.table()) return null;
    const x = this.x;
    return (listener, player) => {
      counts.scans++;
      const h = x.showself_scan(handleOf(listener), handleOf(player));
      const found = h === 0 ? null : identityOfHandle(h);
      if (found === null) counts.ended++; else counts.found++;
      if (mode === 'verify') this.verify(listener, player, found, read, next);
      return found;
    };
  }
  /** The body's walk from `listener`: Rust's answer is the first pawn the body would look at, or an earlier pawn it could not read (a
   * bound or host image), or null with no pawn for the body to look at. Every pawn before the answer must be one the body skips, and
   * the answer must be on the list from `listener`. */
  verify(listener, player, found, read, next) {
    let atFound = false;
    for (let l = listener; l; l = next(l)) {
      if (l === found) { atFound = true; break; }
      if (l === player) { counts.skipped++; continue; }
      const counter = read(l);
      if (counter < 0 || Number.isNaN(counter))
        throw new Error(`SHOW_SELF=verify: Rust skipped ${l.name} (SightCounter ${counter}) and answered ${found?.name ?? 'the end of the list'}`);
      counts.skipped++;
    }
    if (found !== null && !atFound) throw new Error(`SHOW_SELF=verify: Rust answered ${found.name}, which is not on the list from ${listener.name}`);
    if (found !== null) {
      let counter = NaN;
      try { counter = found === player ? 0 : read(found); } catch { /* a pawn the body reads through its host path */ }
      if (!(counter < 0 || Number.isNaN(counter))) counts.unreadable++;
    }
    counts.verified++;
  }
}
