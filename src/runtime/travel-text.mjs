/** The travel text: ExportTravel's output and SpawnPlayActor's input (docs/travel.md "ExportTravel: the travel text"). This
 * module reads and compares it; travel-export.mjs writes it and travel-import.mjs applies it.
 *
 * A text is a list of records, each `Class=<class path> Name=<object name> Ptr=<%08x>` then `{`, one `Name[i]=value` line
 * per exported property element, and `}`; lines end with `\r\n`. An object property is `Name=<%08x> <object name>` (or
 * `None`). The records' pointers are runtime addresses and the names carry per-session instance numbers, so two texts of
 * the same state differ in both: {@link normalizeTravelText} renames pointers by first appearance and strips instance
 * numbers, which is how Play's text is compared with the measured original's. */

export class TravelTextError extends Error {
  constructor(message) { super(message); this.name = 'TravelTextError'; }
}

/** `Class=… Name=… Ptr=…` header, then `{`, the property lines, `}`. Both `\r\n` and `\n` are read. */
export function parseTravelText(text) {
  const lines = String(text).split(/\r?\n/);
  const records = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') continue;
    const header = /^Class=(\S+) Name=(\S+) Ptr=([0-9a-fA-F]+)$/.exec(line);
    if (!header) throw new TravelTextError(`travel text line ${i + 1}: expected a record header, got ${JSON.stringify(line)}`);
    if (lines[++i] !== '{') throw new TravelTextError(`travel text line ${i + 1}: expected "{" after ${header[2]}`);
    const properties = [];
    for (i++; i < lines.length && lines[i] !== '}'; i++) properties.push(lines[i]);
    if (i >= lines.length) throw new TravelTextError(`travel text: record ${header[2]} is not closed`);
    records.push({ class: header[1], name: header[2], ptr: header[3].toLowerCase(), lines: properties });
  }
  return records;
}

/** The text of a record list, as ExportTravel writes it (`\r\n` line ends). */
export function formatTravelText(records) {
  let out = '';
  for (const record of records) {
    out += `Class=${record.class} Name=${record.name} Ptr=${record.ptr}\r\n{\r\n`;
    for (const line of record.lines) out += `${line}\r\n`;
    out += '}\r\n';
  }
  return out;
}

/** One property line: `Name`, optional `[index]`, the value (the importer's grammar: skip leading spaces, letters/digits/`_`). */
export function parsePropertyLine(line) {
  const match = /^ *([A-Za-z0-9_]+)(?:\[(\d+)\])?=(.*)$/s.exec(line);
  if (!match) return null;
  return { name: match[1], index: match[2] === undefined ? 0 : Number(match[2]), indexed: match[2] !== undefined, value: match[3] };
}

/** An object-property value: `<%08x> <object name>` or `None`. */
export function parseObjectValue(value) {
  if (value === 'None') return { ptr: null, name: null };
  const match = /^([0-9a-fA-F]{8}) (\S+)$/.exec(value);
  return match ? { ptr: match[1].toLowerCase(), name: match[2] } : null;
}

const stripInstance = name => name.replace(/\d+$/, '#');

/** The text with pointers renamed `@n` by order of first appearance and instance numbers (`FlagBool36`) replaced by `#`. Records,
 * properties and values keep their order. The same state in two sessions (or in the original and in Play) normalizes equal. */
export function normalizeTravelText(textOrRecords) {
  const records = typeof textOrRecords === 'string' ? parseTravelText(textOrRecords) : textOrRecords;
  const pointers = new Map();
  const pointer = ptr => {
    if (!pointers.has(ptr)) pointers.set(ptr, `@${pointers.size}`);
    return pointers.get(ptr);
  };
  const out = [];
  for (const record of records) {
    out.push(`Class=${record.class} Name=${stripInstance(record.name)} Ptr=${pointer(record.ptr.toLowerCase())}`, '{');
    for (const line of record.lines) {
      const property = parsePropertyLine(line);
      const object = property ? parseObjectValue(property.value) : null;
      if (property && object && object.ptr !== null)
        out.push(`${property.name}${property.indexed ? `[${property.index}]` : ''}=${pointer(object.ptr)} ${stripInstance(object.name)}`);
      else out.push(line);
    }
    out.push('}');
  }
  return out.join('\n');
}

/** The first line at which two normalized texts differ (`{line, expected, actual}`), or null when they are equal. */
export function firstTravelTextDifference(expected, actual) {
  const a = normalizeTravelText(expected).split('\n'), b = normalizeTravelText(actual).split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    if (a[i] !== b[i]) return { line: i + 1, expected: a[i] ?? null, actual: b[i] ?? null };
  return null;
}

/** The travel text of a measured capture (`.work/travel/**.travel.txt`, tools/dump-travel-win.c): the value of the level's
 * TravelInfo pair under `[<n>] value:`, up to the next `[<n>] end`. Returns {map, key, text} of the last level listed. */
export function travelTextOfDump(dump) {
  const lines = String(dump).split(/\r?\n/);
  let map = null, key = null, start = -1, end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const level = /^Level MyLevel slot/.exec(lines[i]);
    if (level) { map = null; key = null; start = -1; end = lines.length; continue; }
    const m = /^ {2}URL\.Map: (.*)$/.exec(lines[i]);
    if (m) map = m[1];
    const k = /^ {2}\[\d+\] key: (.*)$/.exec(lines[i]);
    if (k) key = k[1];
    if (/^ {2}\[\d+\] value:$/.test(lines[i])) start = i + 1;
    if (start >= 0 && /^ {2}\[\d+\] end$/.test(lines[i])) end = i;
  }
  if (start < 0) throw new TravelTextError('the dump holds no TravelInfo value');
  return { map, key, text: lines.slice(start, end).join('\r\n') };
}
