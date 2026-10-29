import {compileFunction} from './script-vm.mjs';

const NO_FIELDS = Object.freeze([]);

/** A prepared function (`identity.function`): its metadata, its parameter and local properties and its result property, and its compiled
 * body on demand.
 *
 * Host representation only (docs/live-heap.md "Load records and functions"). Preparation used to keep a CompiledFunction for each of
 * the Island's 7,000 functions although about a tenth of them ever run, and two lists of property identities, 30% of them empty and 58%
 * the same list twice. A function with no property shares one empty list, a function whose properties are all parameters one list for
 * both (nothing writes either: they are read for the frame layout, the call signature and the parameter count). The compiled body is
 * made at the first read of `compiled`, released as preparation leaves it: its tree is decoded again at its first run, as it always
 * was for a body that had not run. */
export class FunctionRecord {
  constructor(record, script, fields) {
    this.record = record;
    this.script = script;
    const parameters = fields.filter(field => field.metadata.parameter && !field.metadata.return);
    this.fields = fields.length === 0 ? NO_FIELDS : fields;
    this.parameters = parameters.length === 0 ? NO_FIELDS : parameters.length === fields.length ? this.fields : parameters;
    this.result = fields.find(field => field.metadata.return) ?? null;
    this.body = null;
  }
  get compiled() { return this.body ??= compileFunction(this.script, true); }
  set compiled(value) { this.body = value; }
}
