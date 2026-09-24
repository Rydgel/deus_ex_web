/** Differential check of the DeusExTextParser translation against DeusExText.dll.
 *
 * scripts/native-text-parser-oracle.py runs the original parser methods over
 * the original Core.dll and MSVCRT.dll. This validator runs
 * src/runtime/script-text-parser.mjs over the same steps and compares the
 * complete parser state after each one: the mutated text buffer, both
 * positions, lastText/lastTag/lastName, both colours with their alpha bytes,
 * the paragraph flag, the player names and the email/file fields. The corpus
 * is every XExtString in DeusExText.u, read the way InformationDevices reads
 * one; targeted cases add the edge behaviour the corpus does not reach. Reads
 * the original makes past its allocation must fault in both. See
 * docs/script-text-parser.md. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';

import {AssetStore} from '../src/unreal/assets.mjs';
import {readObject} from '../src/unreal/objects.mjs';
import {
  TextParserBufferError, constructTextParser, textParserCloseText, textParserGetColor,
  textParserGetName, textParserGetTag, textParserGetText, textParserIsEOF, textParserOpenText,
  textParserProcessText, textParserSetPlayerName, textParserSnapshot,
} from '../src/runtime/script-text-parser.mjs';
import {gameDirectory} from './game-directory.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const python = process.env.NATIVE_PROBE_PYTHON;
if (!python) throw new Error('Set NATIVE_PROBE_PYTHON to the Unicorn probe environment (see docs/native-exec-diff.md)');

const root = gameDirectory();
const files = (await readdir(path.join(root, 'System'))).map(name => ({
  path: `System/${name}`, read: () => readFile(path.join(root, 'System', name)),
}));
const assets = new AssetStore(files);
const textPackage = await assets.get('DeusExText');

/** XExtString::Serialize (Extension 0x10044140): tagged properties, then Text. */
const corpus = [];
for (const [position, entry] of textPackage.pkg.exports.entries()) {
  if (entry.className !== 'ExtString') continue;
  const object = readObject(textPackage.pkg, textPackage.bytes, position + 1);
  const text = object.reader.string(textPackage.pkg.version);
  assert.equal(object.reader.offset, entry.serialSize, `${entry.path} has no bytes after Text`);
  corpus.push({name: entry.path, text});
}
assert.equal(corpus.length, 492, 'DeusExText.u carries 492 XExtString objects');

const open = (name, texts, player = 'JC Denton', extra = [{op: 'drain'}]) => ({
  texts, steps: [{op: 'construct'}, {op: 'setPlayerName', name: player},
    {op: 'openText', name, package: 'DeusExText'}, ...extra, {op: 'closeText'}],
});
const one = (id, text, options = {}) => ({id, ...open('Case', {'DeusExText.Case': text}, options.player, options.steps)});
const cases = corpus.map(({name, text}) => ({id: name, ...open(name, {[`DeusExText.${name}`]: text})}));
const manual = n => Array.from({length: n}, () => [{op: 'processText'}, {op: 'getTag'}]).flat();
cases.push(
  one('unterminated-tag-at-end', '<P>abc<'),
  one('unclosed-tag-body', '<P>a<B b c'),
  one('comment-nested-tag-at-end', '<P><COMMENT>x<B>'),
  one('comment-nested-skips-next', '<P>a<COMMENT>q<B>zy</COMMENT>b'),
  // The skipped character is the '<' of the end tag, so </COMMENT> is missed.
  one('comment-skip-hides-end-tag', '<P>a<COMMENT>q<B></COMMENT>b<P>c'),
  one('note-and-goal', '<P><NOTE>n1</NOTE>t<GOAL=Goal_1>do <I>it</GOAL>u'),
  one('graphic-font-label', '<P><G=SomeGraphic>x<F=fonts.Big><L><G=><G>',
    {steps: [...manual(1), {op: 'getName'}, ...manual(2), {op: 'getName'}, ...manual(1), {op: 'getName'},
      ...manual(1), {op: 'getName'}, ...manual(1), {op: 'getName'}, {op: 'drain'}]}),
  one('getname-asserts-for-text', '<P>abc', {steps: [...manual(1), {op: 'getName'}]}),
  one('colors', '<P><C=300,-1, 12>a</C>b<DC=7>c<C>d<C=,,>e<C= 1 , 2 ,3,4>f'),
  one('color-wrap', '<P><C=4294967297,2147483648,99999999999>x'),
  one('color-conversion-overflow', '<P><C=0000000000000000000001>x'),
  one('file-fields', '<P><FILE=  name  ,  desc with spaces  >a<FILE=only>b<FILE=a,b,c>c<FILE>d<FILE=   ,x>'),
  one('email-fields', '<P><EMAIL=n,s,f,t,c>a<EMAIL=n2,s2>b<EMAIL= a , b , c , d , e , f>'),
  one('brackets', '<P>a</<>b</>>c<>d>e'),
  one('player-names', '<P><PLAYERNAME> and <PLAYERFIRSTNAME>.'),
  one('player-without-space', '<P><PLAYERFIRSTNAME>|<PLAYERNAME>', {player: 'JCDenton'}),
  one('player-empty', '<P><PLAYERFIRSTNAME>|<PLAYERNAME>', {player: ''}),
  one('player-leading-space', '<P><PLAYERFIRSTNAME>|<PLAYERNAME>', {player: ' JC  Denton'}),
  one('lowercase-tags', '<p>abc<b>d'),
  one('text-before-paragraph', 'xyz<B>abc<P>def'),
  one('empty-text', ''),
  one('layout-tags', '<P>a<NP>b<JL>c<JR>d<U>e</U><I>f</I><TEXT>g'),
  one('crlf', '<P>a\r\n\r\nb\rc\nd'),
  one('repeated-paragraphs', '<P><P>abc<P><P>'),
  one('leading-close', '>>><P>x>'),
  {id: 'missing-object', ...open('Absent', {})},
  {id: 'reopen', texts: {'DeusExText.A': '<P>first', 'DeusExText.B': '<P>second'},
    steps: [{op: 'construct'}, {op: 'openText', name: 'A', package: 'DeusExText'}, ...manual(1),
      {op: 'openText', name: 'B', package: 'DeusExText'}, {op: 'drain'},
      {op: 'openText', name: 'Absent', package: 'DeusExText'}, {op: 'drain'}]},
);

const output = execFileSync(python, [path.join(here, 'native-text-parser-oracle.py'), root],
  {input: JSON.stringify({cases}), encoding: 'utf8', maxBuffer: 1 << 30});
const original = new Map(output.trim().split('\n').map(line => JSON.parse(line)).map(result => [result.id, result]));

const digest = units => createHash('sha1').update(Buffer.from(new Uint16Array(units).buffer)).digest('hex');
const names = new Map([['NONE', 'None']]);
const internName = text => {
  if (text === '') return 'None';
  const key = text.toUpperCase();
  if (!names.has(key)) names.set(key, text);
  return names.get(key);
};
const color = value => [value.r, value.g, value.b, value.a];

function runScript(testCase, reference) {
  let state = null, loads = [];
  const steps = [];
  for (const [index, step] of testCase.steps.entries()) {
    const recorded = reference.steps[index];
    const record = {op: step.op};
    const services = {
      loadText: textPath => { loads.push(textPath); return testCase.texts[textPath] ?? null; },
      allocateText: () => recorded.state?.textAddress ?? 0x30000000,
      name: internName,
    };
    try {
      if (step.op === 'construct') {
        state = constructTextParser({objectAddress: recorded.objectAddress});
        record.objectAddress = recorded.objectAddress;
      } else if (step.op === 'setPlayerName') textParserSetPlayerName(state, step.name);
      else if (step.op === 'openText') record.result = textParserOpenText(state, step.name, step.package, services) ? 1 : 0;
      else if (step.op === 'processText') record.result = textParserProcessText(state, services) ? 1 : 0;
      else if (step.op === 'isEOF') record.result = textParserIsEOF(state) ? 1 : 0;
      else if (step.op === 'getTag') record.result = textParserGetTag(state);
      else if (step.op === 'getText') record.result = textParserGetText(state);
      else if (step.op === 'getName') record.result = textParserGetName(state);
      else if (step.op === 'getColor') record.result = color(textParserGetColor(state));
      else if (step.op === 'closeText') textParserCloseText(state);
      else if (step.op === 'drain') {
        record.records = [];
        for (let count = 0; count < 5000; count++) {
          const more = textParserProcessText(state, services) ? 1 : 0;
          const snapshot = textParserSnapshot(state);
          record.records.push({more, tag: textParserGetTag(state), text: textParserGetText(state),
            color: color(textParserGetColor(state)), textPos: snapshot.textPos, tagEndPos: snapshot.tagEndPos,
            flags: snapshot.bParagraphStarted ? 1 : 0, lastName: snapshot.lastName,
            lastColor: snapshot.lastColor, buffer: snapshot.text ? digest(snapshot.text) : null});
          if (!more) break;
        }
      }
    } catch (error) {
      if (error instanceof TextParserBufferError) record.fault = true;
      else if (/FName\(NULL\)/.test(error.message)) record.stopped = true;
      else if (error instanceof RangeError && /_wtoi/.test(error.message)) record.stopped = true;
      else throw error;
      steps.push(record);
      break;
    }
    const snapshot = textParserSnapshot(state);
    record.state = {...snapshot, textAddress: state.textAddress ?? 0, flags: snapshot.bParagraphStarted ? 1 : 0};
    delete record.state.bParagraphStarted;
    record.loads = loads; loads = [];
    steps.push(record);
  }
  return steps;
}

const comparable = step => {
  const out = {...step};
  if (typeof out.stopped === 'string' || out.stopped === true) out.stopped = true;
  if (typeof out.fault === 'string' || out.fault === true) out.fault = true;
  delete out.events; delete out.loads;
  if (out.records && (out.fault || out.stopped)) delete out.records;
  return out;
};

let compared = 0, faults = 0, stops = 0;
const tags = new Map();
for (const testCase of cases) {
  const reference = original.get(testCase.id);
  assert.ok(reference, `oracle result for ${testCase.id}`);
  const script = runScript(testCase, reference);
  assert.equal(script.length, reference.steps.length, `${testCase.id}: step count`);
  for (const [index, step] of reference.steps.entries()) {
    const label = `${testCase.id} step ${index} (${step.op})`;
    if (step.fault) faults++;
    if (step.stopped) stops++;
    assert.deepEqual(comparable(script[index]), comparable(step), label);
    const loads = (step.events ?? []).filter(event => event.op === 'StaticLoadObject');
    assert.deepEqual(script[index].loads ?? [], loads.map(event => event.path), `${label}: StaticLoadObject paths`);
    for (const event of loads) {
      assert.equal(event.flags, 0x2002, `${label}: LOAD_NoWarn|LOAD_Quiet`);
      assert.equal(event.class, 'XExtString', `${label}: XExtString class`);
    }
    for (const record of step.records ?? []) tags.set(record.tag, (tags.get(record.tag) ?? 0) + 1);
    compared++;
  }
}
assert.ok(faults >= 3, 'past-allocation reads fault in the targeted cases');
assert.ok(stops >= 2, 'FName(NULL) and _wtoi overflow stop in the targeted cases');
console.log(`text parser: ${cases.length} cases (${corpus.length} shipped texts), ${compared} steps identical; ` +
  `${faults} past-allocation faults and ${stops} original stops reproduced; tags ${[...tags].sort((a, b) => a[0] - b[0]).map(([t, n]) => `${t}:${n}`).join(' ')}`);
