/** Static reading of the places in Play's source that route a script native by its index or its function name
 * (docs/native-census.md "How the registry stays true"). src/runtime/native-registry.mjs declares, for each dispatcher, the
 * indices and names it handles; this module reads the dispatcher's own code and reports what that code routes, so the
 * registry test fails when the two disagree in either direction.
 *
 * The code is first stripped of comments and of string, template and regular-expression contents, so prose, error messages
 * and module metadata cannot credit an index. A site is the body of one function (or one table) found by an anchor
 * regular expression; an anchor that no longer matches is an error, never an empty result.
 *
 * Recognised routes (`index` is `call.index` or a local copy of it):
 *   index === N | index !== N      a literal, or a dotted constant (TRIGGER_NATIVE_INDICES.SetBool) from `constants`
 *   [a, b, c].includes(index)      literals and constants
 *   index >= A && index <= B       a range (reported apart: a range that only gates a child dispatcher is no route)
 *   case N:                        literals and constants (`aliases` names local copies of a constant table)
 *   [N, gcFunction]                the rows of a table of handlers (`table: true`)
 *   record.key === 'pkg.class.fn'  a name-bound native (the declaration has no index)
 * Anything else that looks up the index at run time (`set.has(index)`, `map.get(index)`, `x[index]`) is reported under
 * `dynamic`, so a new form of dispatch cannot slip in unnoticed. */
import {readFile} from 'node:fs/promises';
import path from 'node:path';

export function blankNonCode(source, {keepStrings = false} = {}) {
  let out = '', i = 0, previous = '';
  const regexAllowed = () => /[=(,:;!&|?{}[]/.test(previous) || /\b(return|typeof|case|throw|in|of)\s*$/.test(out.slice(-16));
  while (i < source.length) {
    const c = source[i], next = source[i + 1];
    if (c === '/' && next === '/') { while (i < source.length && source[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && next === '*') {
      out += '  '; i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) { out += source[i] === '\n' ? '\n' : ' '; i++; }
      out += '  '; i += 2; continue;
    }
    const quote = c === '"' || c === "'" || c === '`' ? c : c === '/' && regexAllowed() ? '/' : null;
    if (quote) {
      // keepStrings keeps the contents of '...' and "..." (a record key is one); comments stay blank.
      const keep = keepStrings && (quote === "'" || quote === '"');
      out += quote; i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') { out += keep ? source.slice(i, i + 2) : '  '; i += 2; continue; }
        if (quote === '/' && source[i] === '[') { while (i < source.length && source[i] !== ']') { out += ' '; i++; } }
        out += keep ? source[i] : source[i] === '\n' ? '\n' : ' '; i++;
      }
      out += quote; i++; previous = quote; continue;
    }
    out += c; if (!/\s/.test(c)) previous = c; i++;
  }
  return out;
}

/** The two views of a file: `code` (comments and all string contents blanked) and `text` (comments blanked, '...' and "..."
 * kept, for record keys). */
export const sourceViews = source => ({code: blankNonCode(source), text: blankNonCode(source, {keepStrings: true})});

/** One site: from the anchor to the end of the function body (or of the table), in both views. */
export function siteBody(views, {id, anchor, table}) {
  const {code, text} = views;
  const match = anchor.exec(code);
  if (!match) throw new Error(`Native dispatch site not found: ${id} (${anchor})`);
  const at = match.index;
  if (table) {
    const end = code.indexOf(']);', at);
    if (end < 0) throw new Error(`Native dispatch table is unterminated: ${id}`);
    return {code: code.slice(at, end + 3), text: text.slice(at, end + 3)};
  }
  // Anchors end at (or just before) the body brace; an anchor that ends at the parameter list's "(" is skipped past its
  // matching ")" first (a destructured parameter holds braces).
  let from = at + match[0].length - 1;
  if (code[from] === '(') { for (let depth = 0; from < code.length; from++) { if (code[from] === '(') depth++; else if (code[from] === ')' && --depth === 0) break; } }
  for (let i = code.indexOf('{', from), depth = 0; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}' && --depth === 0) return {code: code.slice(at, i + 1), text: text.slice(at, i + 1)};
  }
  throw new Error(`Native dispatch site is unterminated: ${id}`);
}

const NUMBER = '0x[0-9a-fA-F]+|\\d+';
const CONSTANT = '[A-Za-z_$][\\w$]*(?:\\.[\\w$]+)+';
const VALUE = `(?:${NUMBER}|${CONSTANT})`;
const INDEX = '(?:[A-Za-z_$][\\w$]*\\??\\.)?index';

/** What one site routes. `constants` maps a dotted constant's head to its object; `aliases` maps a local name used in
 * `case` labels (`case index.openText:`) to one. */
export function routedByCode(site, {constants = {}, aliases = {}, table = false} = {}) {
  const {code, text} = site;
  const resolve = (word, scope = constants) => {
    if (/^(0x[0-9a-fA-F]+|\d+)$/.test(word)) return Number(word);
    const [head, ...rest] = word.split('.');
    const root = scope[head];
    const value = rest.reduce((object, key) => object?.[key], root);
    if (!Number.isInteger(value)) throw new Error(`Unresolved native index constant ${word}`);
    return value;
  };
  const scope = {...constants, ...aliases};
  const indices = new Set(), ranges = [], names = new Set(), dynamic = new Set();
  // A branch that only throws for its index refuses the native: it is no route.
  const body = code.replace(new RegExp(`if\\s*\\(\\s*${INDEX}\\s*===\\s*(?:${NUMBER})\\s*\\)\\s*throw\\b`, 'g'), '');
  for (const m of body.matchAll(new RegExp(`\\b${INDEX}\\s*[!=]==\\s*(${VALUE})`, 'g'))) indices.add(resolve(m[1], scope));
  for (const m of body.matchAll(new RegExp(`(${NUMBER})\\s*[!=]==\\s*${INDEX}\\b`, "g"))) indices.add(resolve(m[1], scope));
  for (const m of body.matchAll(new RegExp(`\\[([^\\[\\]]*)\\]\\.includes\\(\\s*${INDEX}\\s*\\)`, 'g')))
    for (const item of m[1].split(',')) if (item.trim()) indices.add(resolve(item.trim(), scope));
  const rangeSpans = [];
  for (const m of body.matchAll(new RegExp(`\\b${INDEX}\\s*>=\\s*(${VALUE})\\s*&&\\s*${INDEX}\\s*<=\\s*(${VALUE})`, 'g'))) {
    ranges.push([resolve(m[1], scope), resolve(m[2], scope)]);
    rangeSpans.push([m.index, m.index + m[0].length]);
  }
  for (const m of body.matchAll(new RegExp(`\\bcase\\s+(${VALUE})\\s*:`, 'g'))) indices.add(resolve(m[1], scope));
  if (table) for (const m of body.matchAll(/\[\s*(\d+)\s*,\s*[A-Za-z_$][\w$]*\s*\]/g)) indices.add(Number(m[1]));
  // A function key has a package, a class and a function; two segments name a class (an ancestry test).
  for (const m of text.matchAll(/\bcall\??\.record\??\.key\s*[!=]==\s*'([^'.]+\.[^'.]+\.[^']+)'/g)) names.add(m[1]);
  // Lookups by the index at run time.
  for (const m of body.matchAll(new RegExp(`([\\w$.?]+)\\.(has|get)\\(\\s*${INDEX}\\s*\\)`, 'g'))) dynamic.add(`${m[1]}.${m[2]}(index)`);
  for (const m of body.matchAll(/\b([A-Za-z_$][\w$.]*)\[\s*(?:call\??\.)?index\s*\]/g)) dynamic.add(`${m[1]}[index]`);
  return {indices, ranges, names, dynamic};
}

export function expandRanges(ranges) {
  const out = new Set();
  for (const [from, to] of ranges) for (let index = from; index <= to; index++) out.add(index);
  return out;
}

const list = indices => [...indices].sort((a, b) => a - b);

/** Read every registered site (src/runtime/native-registry.mjs NATIVE_SITES) from `base`. Returns Map(id -> routed). */
export async function readSites(sites, {base = '.', constants = {}} = {}) {
  const views = new Map(), out = new Map();
  for (const site of sites) {
    if (!site.anchor || site.parsed === false) continue;
    if (!views.has(site.file)) views.set(site.file, sourceViews(await readFile(path.resolve(base, site.file), 'utf8')));
    const body = siteBody(views.get(site.file), site);
    out.set(site.id, routedByCode(body, {constants, aliases: site.aliases, table: site.table}));
  }
  return out;
}

/** The differences between what a site's code routes and what the registry declares for it. All empty when they agree. */
export function compareSite(site, routed) {
  const gated = new Set(), forwarded = new Set();
  for (const [from, to] of site.gates ?? []) for (let index = from; index <= to; index++) gated.add(index);
  for (const [index] of site.notRoutes ?? []) forwarded.add(index);
  const code = new Set([...routed.indices, ...expandRanges(routed.ranges)]);
  const declared = new Set(site.indices ?? []);
  const accounted = new Set([...declared, ...gated, ...forwarded]);
  const names = new Set(site.names ?? []), dynamic = new Set(site.dynamic ?? []);
  return {
    // routed by the code, declared nowhere
    undeclared: list([...code].filter(index => !accounted.has(index))),
    // declared, but no branch in the code routes it
    unrouted: list([...declared].filter(index => !code.has(index))),
    // a not-route entry the code does not even mention
    staleNotRoutes: list([...forwarded].filter(index => !code.has(index))),
    undeclaredNames: [...routed.names].filter(name => !names.has(name)).sort(),
    unroutedNames: [...names].filter(name => !routed.names.has(name)).sort(),
    undeclaredLookups: [...routed.dynamic].filter(item => !dynamic.has(item)).sort(),
    staleLookups: [...dynamic].filter(item => !routed.dynamic.has(item)).sort(),
  };
}
