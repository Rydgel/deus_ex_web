import {serializeGcScriptExpression} from './script-bytecode-serialization.mjs';

/** Stable original package-object identities. AssetStore.resolve returns a
 * description; native object equality requires one identity per loaded export. */
export class ScriptObjects {
  constructor(assets) {
    this.assets = assets;
    this.objects = new Map();
    this.linkedScripts = new WeakMap();
    this.linkedOperands = new WeakMap();
  }
  async resolve(asset, index) {
    if (!index) return null;
    const resolved = await this.assets.resolve(asset, index);
    return this.exportIdentity(resolved.asset, resolved.index);
  }
  /** Bind an already resolved positive export without repeating import lookup.
   * The native loader supplies the owning linker/index after VerifyImport. */
  exportIdentity(asset, index) {
    const entry = asset.pkg.exports[index - 1];
    if (!Number.isInteger(index) || index <= 0 || !entry)
      throw new Error(`Invalid canonical export ${asset.name}:${index}`);
    const resolved = {asset, index, entry, key: `${asset.name}.${entry.path}`};
    const key = resolved.key.toLowerCase();
    if (!this.objects.has(key)) this.objects.set(key, {
      ...resolved, key, kind: resolved.entry.className, name: resolved.entry.name,
    });
    return this.objects.get(key);
  }
  /** Install a host identity before linking references to this package export.
   * Actor constants, tagged map references, and AllActors must return the same
   * object. Replacing an identity after resolution would leave stale pointers. */
  async bindIdentity(asset, index, identity) {
    if (!identity || typeof identity !== 'object') throw new TypeError('Expected a live package-object identity');
    const resolved = await this.assets.resolve(asset, index), key = resolved.key.toLowerCase();
    const existing = this.objects.get(key);
    if (existing && existing !== identity) throw new Error(`Package identity was already resolved: ${key}`);
    Object.assign(identity, {...resolved, key, kind: resolved.entry.className, name: resolved.entry.name});
    this.objects.set(key, identity);
    return identity;
  }
  /** Link operands before synchronous execution; no async gap inside a script
   * event. Native fields/functions/classes/resources retain package provenance. */
  async link(script, decoded) {
    if (this.linkedScripts.has(script)) {
      if(this.linkedOperands.get(script).decoded!==decoded)
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
    const objects=new Map(),names=new Set();
    for(const node of decoded.expressions.values()){
      const index=node.fieldIndex??node.functionIndex??node.objectIndex;
      if(index!==undefined)objects.set(node,bindings.get(index));
      if(node.nameIndex!==undefined)names.add(node);
      for(const label of node.labels??[])names.add(label);
    }
    this.linkedScripts.set(script,bindings);
    this.linkedOperands.set(script,{decoded,objects,names});
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
    const operands=this.linkedOperands.get(script)?.objects;
    if(!operands?.has(node))throw new Error(`Unlinked bytecode operand ${script.entry.path}:${node?.offset}`);
    return {reference:true,get:()=>operands.get(node),set:value=>{
      if(value!==null&&typeof value!=='object')throw new TypeError('Bytecode object operand requires UObject identity or null');
      operands.set(node,value);
    }};
  }
  operand(script,node) {
    // operandReference(...).get() without allocating the lvalue per access.
    const operands=this.linkedOperands.get(script)?.objects;
    if(!operands?.has(node))throw new Error(`Unlinked bytecode operand ${script.entry.path}:${node?.offset}`);
    return operands.get(node);
  }
  nameOperandReference(script,node) {
    if(!this.linkedOperands.get(script)?.names.has(node))
      throw new Error(`Unlinked bytecode name operand ${script.entry.path}`);
    return {reference:true,get:()=>node.name,set:value=>{
      // Core's collector changes GNames entry flags, never the FName value.
      // Rebuilding execution/state name lookups belongs to a load/save linker.
      if(value!==node.name)throw new Error('The GC archive must not rewrite bytecode FName values');
    }};
  }
  serializeExpression(script,offset,archive) {
    const linked=this.linkedOperands.get(script);
    if(!linked)throw new Error(`Script bytecode is not linked: ${script.entry.path}`);
    return serializeGcScriptExpression(script,linked.decoded,offset,archive,{
      objectOperand:node=>this.operandReference(script,node),
      nameOperand:node=>this.nameOperandReference(script,node),
    });
  }
}
