import {serializeGcScriptExpression} from './script-bytecode-serialization.mjs';
import {decodeScript} from '../unreal/bytecode.mjs';
import {METADATA_KINDS} from './original-loaded.mjs';
import { exportAt } from '../unreal/objects.mjs';

// Resource objects: loaded with the package that holds them and collected like a class (docs/class-graph-design.md "The collection over
// classes"), so they are the process's.
export const RESOURCE_KINDS = Object.freeze(new Set(['Texture', 'Palette', 'Sound', 'Music', 'LodMesh', 'Mesh', 'Font',
  'FireTexture', 'WaterTexture', 'WaveTexture', 'WetTexture', 'IceTexture', 'FractalTexture', 'ScriptedTexture']));
// The objects a level attaches as script instances (ScriptRuntime.prepareObject): DeusExConText's conversations, the conversation audio
// lists and DeusExText's strings. The original unloads DeusExConText at each LoadMap collection that leaves no conversation object
// (docs/script-loadmap-gc.md), so each level holds its own.
const LEVEL_OBJECT_KINDS = new Set(['Conversation', 'ConversationList', 'ConversationMissionList', 'ConItem', 'ConChoice', 'ConFlagRef',
  'ConSpeech', 'ConAudioList', 'ConEventAddCredits', 'ConEventAddGoal', 'ConEventAddNote', 'ConEventAddSkillPoints', 'ConEventCheckFlag',
  'ConEventCheckObject', 'ConEventCheckPersona', 'ConEventChoice', 'ConEventComment', 'ConEventEnd', 'ConEventJump', 'ConEventMoveCamera',
  'ConEventRandomLabel', 'ConEventSetFlag', 'ConEventSpeech', 'ConEventTransferObject', 'ConEventTrigger', 'ExtString']);

/** Whose identity an export is (docs/class-graph-design.md "Identities and generations"): 'level' for every export of a level package (a
 * map, a filed `.dxs` level) and for the objects a level attaches; 'process' for metadata (classes and their functions, states, structs,
 * properties, enums, consts, text buffers, packages) and resources. An export of another kind is not classified, and throws. */
export function exportScope(asset, entry) {
  if (/\.(dx|dxs|unr)$/i.test(asset?.path ?? '')) return 'level';
  const kind = entry.className;
  if (METADATA_KINDS.has(kind) || RESOURCE_KINDS.has(kind)) return 'process';
  if (LEVEL_OBJECT_KINDS.has(kind)) return 'level';
  throw new Error(`Identity scope of ${asset?.name}.${entry.path} (${kind}) is not classified: neither a level's nor the process's`);
}

/** Stable original package-object identities. AssetStore.resolve returns a
 * description; native object equality requires one identity per loaded export.
 *
 * Two tables (docs/class-graph-design.md, migration step 2): the level's (`objects`: the level package's exports, which a host binds
 * with bindIdentity, and the objects the level attaches) and the process's (`packageObjects`, ScriptProcess: metadata and resources,
 * which outlive the level). Linked bytecode is readiness and lives with the process. Without a process (a fixture, a registry of its own)
 * there is one table, and no export is classified. */
export class ScriptObjects {
  constructor(assets, process = null) {
    this.assets = assets;
    this.process = process;
    this.objects = new Map();
    this.packageObjects = process?.packageObjects ?? this.objects;
    this.linkedScripts = process?.linkedScripts ?? new WeakMap();
    this.linkedOperands = process?.linkedOperands ?? new WeakMap();
    // Advances whenever an expanded operand can change (link, GC rewrite), so
    // callers may keep a resolved operand while it is unchanged.
    this.operandCount = 0;
    // Called after each advance (the Rust interpreter's event cache).
    this.operandListeners = [];
  }
  get operandEpoch() { return this.operandCount; }
  set operandEpoch(value) {
    this.operandCount = value;
    for (const listener of this.operandListeners) listener();
  }
  async resolve(asset, index) {
    if (!index) return null;
    const resolved = await this.assets.resolve(asset, index);
    return this.exportIdentity(resolved.asset, resolved.index);
  }
  /** Bind an already resolved positive export without repeating import lookup.
   * The native loader supplies the owning linker/index after VerifyImport. */
  exportIdentity(asset, index) {
    const entry = exportAt(asset.pkg, index);
    if (!Number.isInteger(index) || index <= 0 || !entry)
      throw new Error(`Invalid canonical export ${asset.name}:${index}`);
    // A small integer (it indexes the export table), kept as a Smi: a heap number stored here would make V8 box `index` in
    // every identity (docs/live-heap.md "Steps 2 and 3's results").
    const key = `${asset.name}.${entry.path}`.toLowerCase(), table = this.tableOf(asset, entry);
    let identity = table.get(key);
    if (!identity) {
      // The identity keeps no entry: `entryOf(identity)` makes it from `asset` and `index` (docs/live-heap.md "Package tables").
      // One literal with the keys the process adds later (the load record, the prepared function, the property's metadata and its link in
      // progress): each added after the literal was an out-of-line property array on every identity, 31,600 objects on the Island
      // (docs/live-heap.md "Load records and functions"). It stays a plain object (bench-sim's digest hashes by prototype).
      // `fieldPending` is the link's promise while it runs and `true` once it has finished (ScriptRuntime.field).
      table.set(key, identity = {asset, index: index | 0, key, kind: entry.className, name: entry.name,
        loadRecord: undefined, function: undefined, metadata: undefined, fieldPending: undefined});
      if (table === this.packageObjects) this.process?.hold(identity);
    }
    return identity;
  }
  /** The table an export's identity lives in (exportScope). */
  tableOf(asset, entry) {
    if (!this.process) return this.objects;
    return exportScope(asset, entry) === 'level' ? this.objects : this.packageObjects;
  }
  /** The identity already minted for a lower-case export key, from either table, or undefined. */
  lookup(key) {
    return this.objects.get(key) ?? (this.process ? this.packageObjects.get(key) : undefined);
  }
  /** Install a host identity before linking references to this package export.
   * Actor constants, tagged map references, and AllActors must return the same
   * object. Replacing an identity after resolution would leave stale pointers. */
  async bindIdentity(asset, index, identity) {
    if (!identity || typeof identity !== 'object') throw new TypeError('Expected a live package-object identity');
    const resolved = await this.assets.resolve(asset, index), key = resolved.key.toLowerCase();
    if (this.tableOf(resolved.asset, resolved.entry) !== this.objects)
      throw new Error(`A host identity binds a level's export, not the process's: ${key}`);
    const existing = this.objects.get(key);
    if (existing && existing !== identity) throw new Error(`Package identity was already resolved: ${key}`);
    Object.assign(identity, {asset: resolved.asset, index: resolved.index, key, kind: resolved.entry.className, name: resolved.entry.name});
    this.objects.set(key, identity);
    return identity;
  }
  /** Link operands before synchronous execution; no async gap inside a script
   * event. Native fields/functions/classes/resources retain package provenance.
   * Each expanded operand is keyed by its expression's offset, not by its node, so
   * a body's tree can be released and decoded again (docs/live-heap.md step 8). */
  async link(script, decoded) {
    if (this.linkedScripts.has(script)) {
      const objects = this.linkedOperands.get(script);
      for (const node of decoded.expressions.values())
        if ((node.fieldIndex ?? node.functionIndex ?? node.objectIndex) !== undefined && !objects.has(node.offset))
          throw new Error('Script already has a different linked bytecode buffer');
      return this.linkedScripts.get(script);
    }
    const asset = script.asset;
    if (!asset) throw new Error('Script linking requires its source package asset');
    const indices = new Set();
    for (const node of decoded.expressions.values()) {
      for (const name of ['fieldIndex','functionIndex','objectIndex']) {
        if (node[name] !== undefined) indices.add(node[name]);
      }
    }
    const bindings = new Map(await Promise.all([...indices].map(async index => [index, await this.resolve(asset,index)])));
    const objects=new Map();
    for(const node of decoded.expressions.values()){
      const index=node.fieldIndex??node.functionIndex??node.objectIndex;
      if(index!==undefined)objects.set(node.offset,bindings.get(index));
    }
    this.linkedScripts.set(script,bindings);
    this.linkedOperands.set(script,objects);
    this.operandEpoch++;
    return bindings;
  }
  /** Package-index lookup is for linking metadata. Execution reads the
   * individual expanded operand, which GC may clear independently of other
   * occurrences of that same original package index. */
  reference(script, index) {
    if (!index) return null;
    const bindings = this.linkedScripts.get(script);
    if (!bindings?.has(index)) throw new Error(`Unlinked script reference ${script.entry.path}:${index}`);
    return bindings.get(index);
  }
  operandReference(script,node) {
    const operands=this.linkedOperands.get(script),offset=node?.offset;
    if(!operands?.has(offset))throw new Error(`Unlinked bytecode operand ${script.entry.path}:${offset}`);
    return {reference:true,get:()=>operands.get(offset),set:value=>{
      if(value!==null&&typeof value!=='object')throw new TypeError('Bytecode object operand requires UObject identity or null');
      operands.set(offset,value);this.operandEpoch++;
    }};
  }
  operand(script,node) {
    // operandReference(...).get() without allocating the lvalue per access.
    const operands=this.linkedOperands.get(script);
    if(!operands?.has(node?.offset))throw new Error(`Unlinked bytecode operand ${script.entry.path}:${node?.offset}`);
    return operands.get(node.offset);
  }
  nameOperandReference(script,node) {
    // A name operand: an expression's or a label table entry's FName (both carry nameIndex).
    if(!this.linkedOperands.has(script)||node?.nameIndex===undefined)
      throw new Error(`Unlinked bytecode name operand ${script.entry.path}`);
    return {reference:true,get:()=>node.name,set:value=>{
      // Core's collector changes GNames entry flags, never the FName value.
      // Rebuilding execution/state name lookups belongs to a load/save linker.
      if(value!==node.name)throw new Error('The GC archive must not rewrite bytecode FName values');
    }};
  }
  serializeExpression(script,offset,archive) {
    if(!this.linkedOperands.has(script))throw new Error(`Script bytecode is not linked: ${script.entry.path}`);
    // The operands are keyed by offset, so a decode of the script's own bytes walks the same slots. One tree is kept for the
    // expressions that follow in the same body.
    if(this.serializing?.script!==script)this.serializing={script,decoded:decodeScript(script)};
    return serializeGcScriptExpression(script,this.serializing.decoded,offset,archive,{
      objectOperand:node=>this.operandReference(script,node),
      nameOperand:node=>this.nameOperandReference(script,node),
    });
  }
}
