#!/usr/bin/env node
/** Functions that allocate a context object on every call (host measurement only; docs/live-heap.md "Cut: tick and actors").
 *
 * V8 allocates a function's context when the function is entered, not when the closure that needs it is created: a function with a
 * parameter, a local or `this` that an inner function (an arrow in a `.map`, a callback) refers to makes the context at its first
 * instruction, whichever path the call then takes. TurboFan removes the allocation when the function is inlined and the closure never
 * escapes; Maglev and the interpreter do not, so a hot function with an early return in front of its closures allocates 40 to 100
 * bytes a call. The cure is to keep the closures out of the hot path: split the slow path into a function of its own.
 *
 *   node scripts/closure-context-scan.mjs [--dir src] [--min 1] [--profile FILE ...] [--only a.mjs,b.mjs]
 *
 * Without --profile, every function whose own scope is captured (parameters, locals, `this`) is listed by file and line. A block
 * scope that is captured (a loop body with a closure) makes its context at each block entry; those are listed after the function's.
 * With --profile FILE (the output of frame-alloc-meter.mjs --sites), only the functions that appear as allocation leaves in it are
 * listed, with their KB a frame.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { parseAst } from 'vite';

const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1]; };
const dir = option('dir', 'src'), only = option('only', null)?.split(',') ?? null;
const profiles = argv.flatMap((a, i) => a === '--profile' ? [argv[i + 1]] : []);

function* walkFiles(root) {
  for (const name of readdirSync(root)) {
    const path = `${root}/${name}`;
    if (statSync(path).isDirectory()) { if (name !== 'node_modules') yield* walkFiles(path); }
    else if (/\.(mjs|js)$/.test(name)) yield path;
  }
}

class Scope {
  constructor(kind, parent, fn) { this.kind = kind; this.parent = parent; this.fn = fn; this.names = new Map(); this.captured = new Set(); this.line = 0; }
  declare(name) { this.names.set(name, true); }
}

function patternNames(pattern, out = []) {
  if (!pattern) return out;
  switch (pattern.type) {
    case 'Identifier': out.push(pattern.name); break;
    case 'ObjectPattern': for (const p of pattern.properties) patternNames(p.type === 'RestElement' ? p.argument : p.value, out); break;
    case 'ArrayPattern': for (const p of pattern.elements) patternNames(p, out); break;
    case 'AssignmentPattern': patternNames(pattern.left, out); break;
    case 'RestElement': patternNames(pattern.argument, out); break;
  }
  return out;
}

const children = node => {
  const out = [];
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
    const value = node[key];
    if (Array.isArray(value)) { for (const v of value) if (v && typeof v.type === 'string') out.push([key, v]); }
    else if (value && typeof value.type === 'string') out.push([key, value]);
  }
  return out;
};

function scanFile(path) {
  const code = readFileSync(path, 'utf8');
  let ast;
  try { ast = parseAst(code, { lang: 'js' }); } catch (error) { return { error: error.message, functions: [] }; }
  const lineIndex = [0]; for (let i = 0; i < code.length; i++) if (code.charCodeAt(i) === 10) lineIndex.push(i + 1);
  const line = offset => { let lo = 0, hi = lineIndex.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineIndex[mid] <= offset) lo = mid; else hi = mid - 1; } return lo + 1; };
  const fnScopes = new Map();   // function node -> its scope
  const allScopes = [];
  const functions = [];

  const hoist = (body, scope) => {   // the function's var declarations (not those of the functions inside it)
    const visit = node => {
      if (!node || typeof node.type !== 'string') return;
      if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') return;
      if (node.type === 'VariableDeclaration' && node.kind === 'var') for (const d of node.declarations) for (const n of patternNames(d.id)) scope.declare(n);
      for (const [, child] of children(node)) visit(child);
    };
    for (const statement of body) visit(statement);
  };
  const declareLexical = (statements, scope) => {
    for (const s of statements) {
      if (s.type === 'VariableDeclaration' && s.kind !== 'var') for (const d of s.declarations) for (const n of patternNames(d.id)) scope.declare(n);
      else if (s.type === 'FunctionDeclaration' && s.id) scope.declare(s.id.name);
      else if (s.type === 'ClassDeclaration' && s.id) scope.declare(s.id.name);
      else if ((s.type === 'ExportNamedDeclaration' || s.type === 'ExportDefaultDeclaration') && s.declaration) declareLexical([s.declaration], scope);
    }
  };
  const resolve = (name, scope, currentFn) => {
    for (let s = scope; s; s = s.parent) {
      if (s.names.has(name)) { if (s.fn !== currentFn) s.captured.add(name); return; }
    }
  };
  const nameOf = (node, parent, hint) => {
    if (node.id?.name) return node.id.name;
    if (parent?.type === 'MethodDefinition' || parent?.type === 'Property' || parent?.type === 'PropertyDefinition') return parent.key?.name ?? parent.key?.value ?? hint;
    if (parent?.type === 'VariableDeclarator') return parent.id?.name ?? hint;
    if (parent?.type === 'AssignmentExpression') return parent.left?.property?.name ?? parent.left?.name ?? hint;
    return hint ?? '(anon)';
  };

  const visit = (node, scope, fn, parent, hint) => {
    switch (node.type) {
      case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression': {
        const own = new Scope('function', scope, node);
        own.line = line(node.start);
        own.arrow = node.type === 'ArrowFunctionExpression';
        for (const p of node.params) for (const n of patternNames(p)) own.declare(n);
        if (!own.arrow) { own.declare('this'); own.declare('arguments'); }
        if (node.type === 'FunctionExpression' && node.id) own.declare(node.id.name);
        fnScopes.set(node, own); allScopes.push(own);
        functions.push({ node, scope: own, name: nameOf(node, parent, hint), line: own.line });
        if (node.body.type === 'BlockStatement') {
          hoist(node.body.body, own); declareLexical(node.body.body, own);
          for (const p of node.params) visit(p, own, node, node, null);
          for (const s of node.body.body) visit(s, own, node, node.body, null);
        } else { for (const p of node.params) visit(p, own, node, node, null); visit(node.body, own, node, node, null); }
        return;
      }
      case 'BlockStatement': case 'StaticBlock': {
        const block = new Scope('block', scope, fn); block.line = line(node.start); allScopes.push(block);
        declareLexical(node.body, block);
        for (const s of node.body) visit(s, block, fn, node, null);
        return;
      }
      case 'ForStatement': case 'ForInStatement': case 'ForOfStatement': {
        const loop = new Scope('block', scope, fn); loop.line = line(node.start); allScopes.push(loop);
        const init = node.type === 'ForStatement' ? node.init : node.left;
        if (init?.type === 'VariableDeclaration' && init.kind !== 'var') for (const d of init.declarations) for (const n of patternNames(d.id)) loop.declare(n);
        for (const [, child] of children(node)) visit(child, loop, fn, node, null);
        return;
      }
      case 'CatchClause': {
        const clause = new Scope('block', scope, fn); clause.line = line(node.start); allScopes.push(clause);
        for (const n of patternNames(node.param)) clause.declare(n);
        for (const [, child] of children(node)) visit(child, clause, fn, node, null);
        return;
      }
      case 'SwitchStatement': {
        visit(node.discriminant, scope, fn, node, null);
        const block = new Scope('block', scope, fn); block.line = line(node.start); allScopes.push(block);
        for (const c of node.cases) declareLexical(c.consequent, block);
        for (const c of node.cases) for (const [, child] of children(c)) visit(child, block, fn, c, null);
        return;
      }
      case 'ClassDeclaration': case 'ClassExpression': {
        for (const [, child] of children(node)) visit(child, scope, fn, node, node.id?.name ?? hint);
        return;
      }
      case 'Identifier': resolve(node.name, scope, fn); return;
      case 'ThisExpression': resolve('this', scope, fn); return;
      case 'MemberExpression':
        visit(node.object, scope, fn, node, null);
        if (node.computed) visit(node.property, scope, fn, node, null);
        return;
      case 'Property': case 'PropertyDefinition': case 'MethodDefinition':
        if (node.computed) visit(node.key, scope, fn, node, null);
        if (node.value) visit(node.value, scope, fn, node, node.key?.name ?? node.key?.value ?? null);
        return;
      case 'LabeledStatement': visit(node.body, scope, fn, node, null); return;
      case 'BreakStatement': case 'ContinueStatement': return;
      case 'ExportSpecifier': case 'ImportDeclaration': return;
      default:
        for (const [, child] of children(node)) visit(child, scope, fn, node, null);
    }
  };
  const top = new Scope('function', null, null); allScopes.push(top);
  const body = ast.body;
  hoist(body, top); declareLexical(body, top);
  for (const s of body) visit(s, top, null, ast, null);

  const result = [];
  for (const f of functions) {
    const own = f.scope;
    const blocks = allScopes.filter(s => s.kind === 'block' && s.fn === f.node && s.captured.size);
    if (own.captured.size || blocks.length) result.push({ name: f.name, line: f.line, captured: [...own.captured], blocks: blocks.map(b => ({ line: b.line, names: [...b.captured] })) });
  }
  return { functions: result };
}

const leafKb = new Map();   // "name file" -> KB a frame
for (const file of profiles) {
  let sites = false;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    if (/^\s*sites:/.test(raw)) sites = true;
    else if (/^==/.test(raw)) sites = false;
    if (sites) continue;
    const m = raw.match(/^\s*([\d.]+)\s+(.+?)\s*$/);
    if (!m) continue;
    const kb = Number(m[1]);
    let label = m[2].replace(/^(map|filter|sort|next|set|get|forEach|flatMap|some|every|from|values|keys|entries|add|push|slice|replace|fround|Set|Map|Array)\s*<\s*/, '');
    label = label.split(' < ')[0];
    const parts = label.split(/\s+/);
    if (parts.length < 2) continue;
    const key = `${parts[0]} ${parts[parts.length - 1].replace(/:\d+$/, '')}`;
    leafKb.set(key, (leafKb.get(key) ?? 0) + kb);
  }
}

let total = 0;
for (const path of walkFiles(dir)) {
  if (only && !only.some(o => path.endsWith(o))) continue;
  const { functions, error } = scanFile(path);
  if (error) { console.error(`${path}: ${error}`); continue; }
  const shortPath = path.split('/').slice(-2).join('/');
  for (const f of functions) {
    const kb = leafKb.get(`${f.name} ${shortPath}`) ?? 0;
    if (profiles.length && !kb) continue;
    total++;
    const blocks = f.blocks.length ? `  blocks ${f.blocks.map(b => `${b.line}:{${b.names.join(',')}}`).join(' ')}` : '';
    console.log(`${kb ? kb.toFixed(1).padStart(7) : '       '} ${path}:${f.line} ${f.name}  captured {${f.captured.join(',')}}${blocks}`);
  }
}
console.error(`${total} functions`);
