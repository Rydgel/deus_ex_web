/** FStateFrame code/latent continuation. Class lookup and BeginState/EndState
 * dispatch are owned by the object runtime; this layer executes resolved states.
 * Original GotoLabel1012eb10 and ProcessState103e5b60: see docs/door-state.md. */

// The Rust interpreter's state table (script-vm-rust.mjs, docs/rust-core.md
// "State table") keeps, per handle, what GetStateName and probing read here.
// Host bookkeeping, not an original structure: every change of a state's
// node or probe mask, and every replacement of an instance's state, reports
// the object's identity so its entry is computed again.
const stateListeners=[];
/** Call `listener(identity)` after each state change of `identity`. */
export const onStateChange=listener=>{stateListeners.push(listener);};
export function stateChanged(identity) {
  for(const listener of stateListeners)listener(identity);
}
// The same table's frame word: whether `process` has code to run (an
// execution with a cursor) and the latent action it would poll. Every
// LatentAction write that changes it, every cursor write between null and
// an offset, and every new execution report the object's identity.
const frameListeners=[];
/** Call `listener(identity)` after each change of `identity`'s frame word. */
export const onFrameChange=listener=>{frameListeners.push(listener);};
function frameChanged(identity) {
  for(const listener of frameListeners)listener(identity);
}

// A probe mask is two words, and the objects of a class share a few values: one frozen array a value.
const probeWordSets=new Map();
function probeWordsOf(words){
  const key=words.join(',');
  let set=probeWordSets.get(key);
  if(set===undefined)probeWordSets.set(key,set=Object.freeze([...words]));
  return set;
}

// What a runtime's states share: its services and whether a frame's locals are a Map. One object for each (services, mapLocals) pair,
// not two fields in every state.
const configs = new WeakMap();
function configOf(services, mapLocals) {
  if (services === null || typeof services !== 'object') return Object.freeze({services, localsAreMap: Boolean(mapLocals)});
  let pair = configs.get(services);
  if (pair === undefined) configs.set(services, pair = [null, null]);
  const at = mapLocals ? 1 : 0;
  return pair[at] ??= Object.freeze({services, localsAreMap: Boolean(mapLocals)});
}
// A state that runs code has an execution, the node it runs and its locals; the others (most objects never run a state, 166 of the
// Island's 12,000 do) have none of the three. The two booleans of a state change are two bits of one word.
class StateFrame {
  constructor() { this.execution = null; this.codeNode = null; this.localValues = null; }
}
const ENDING = 1, CHANGED = 2;

export class ScriptState {
  /** `mapLocals`: the frame's locals are a Map (the script runtime's objects), else an object. */
  constructor(instance, services = {}, mapLocals = false) {
    this.instance=instance;this.config=configOf(services,mapLocals);this.stateNode=null;
    this.frame=null;this.latentAction=0;this.flags=0;
    this.probeMask=[0,0];
  }
  get services() { return this.config.services; }
  get localsAreMap() { return this.config.localsAreMap; }
  get execution() { return this.frame===null?null:this.frame.execution; }
  set execution(value) {
    if (this.frame === null) { if (value === null) return; this.frame = new StateFrame(); }
    this.frame.execution = value;
  }
  get codeNode() { return this.frame===null?null:this.frame.codeNode; }
  set codeNode(value) {
    if (this.frame === null) { if (value === null) return; this.frame = new StateFrame(); }
    this.frame.codeNode = value;
  }
  get localValues() { return this.frame===null?null:this.frame.localValues; }
  set localValues(value) {
    if (this.frame === null) { if (value === null) return; this.frame = new StateFrame(); }
    this.frame.localValues = value;
  }
  get endingState() { return (this.flags&ENDING)!==0; }
  set endingState(value) { this.flags=value?this.flags|ENDING:this.flags&~ENDING; }
  get changedState() { return (this.flags&CHANGED)!==0; }
  set changedState(value) { this.flags=value?this.flags|CHANGED:this.flags&~CHANGED; }
  /** The frame's locals, made when first asked for: most objects never run a state. */
  get locals() { return this.localValues??=this.localsAreMap?new Map():{}; }
  set locals(value) { this.localValues=value; }
  /** A linked node has {compiled, labels:Map<lowercase name,offset>, base}. */
  setStateNode(node) {
    if(this.execution)this.execution.cursor=null;
    this.stateNode=node;this.execution=null;this.codeNode=null;this.latent=0;
    stateChanged(this.instance);
  }
  /** FStateFrame+0x24 LatentAction. */
  get latent() { return this.latentAction; }
  set latent(value) {
    if(value===this.latentAction)return;
    this.latentAction=value;
    frameChanged(this.instance);
  }
  get probeMask() { return this.probeWords; }
  /** ProbeMask is replaced, never written in place (the words are frozen),
   * so every change reports the state change. */
  set probeMask(words) {
    this.probeWords=probeWordsOf(words);
    stateChanged(this.instance);
  }
  isProbing(ename) {
    const bit=ename-0x12c;
    return bit<0||bit>=64||Boolean(this.probeMask[bit>>>5]&(1<<(bit&31)));
  }
  /** Native GotoState body with an already resolved target. A null node is the
   * no-state class sentinel. Return2 preserves a reentrant event's transition. */
  transition(node,classMetadata) {
    this.latent=0;
    const oldName=this.stateNode?.record.name.toLowerCase()??'none';
    const nextName=node?.record.name.toLowerCase()??'none';
    const event=name=>{
      if(!this.services.dispatchStateEvent)throw new Error(`State event is not linked: ${name}`);
      this.services.dispatchStateEvent(this.instance,name);
    };
    if(oldName!=='none'&&oldName!==nextName&&this.isProbing(0x13d)&&!this.endingState){
      this.changedState=false;this.endingState=true;
      try{event('EndState');}finally{this.endingState=false;}
      if(this.changedState)return 2;
    }
    this.setStateNode(node);
    const metadata=node?.script??classMetadata;
    this.probeMask=classMetadata.probeMask.map((word,i)=>((word|metadata.probeMask[i])&metadata.ignoreMask[i])>>>0);
    if(!node)return 0;
    if(nextName!==oldName&&this.isProbing(0x13c)){
      this.changedState=false;event('BeginState');
      if(this.changedState)return 2;
    }
    this.changedState=true;return 1;
  }
  gotoLabel(name) {
    this.latent=0;
    const key=String(name??'None').toLowerCase();
    if(key!=='none')for(let node=this.stateNode;node;node=node.base){
      const offset=node.labels.get(key);
      if(offset===undefined)continue;
      if(!node.compiled.decoded.statements.has(offset))throw new Error('State label is not an instruction boundary');
      if(this.codeNode===node){
        this.execution.cursor=offset;this.execution.returned=false;
      }else{
        if(this.execution)this.execution.cursor=null;
        this.startFrame(node,offset);
      }
      return true;
    }
    if(this.execution)this.execution.cursor=null;
    return false;
  }
  /** A new code frame for `node` whose cursor starts at `offset` (gotoLabel's, and a restored FStateFrame's). */
  startFrame(node,offset) {
    const execution=node.compiled.createFrame(this.instance,this.locals,this.services,{offset,state:true});
    this.execution=execution;
    this.codeNode=node;
    Object.defineProperty(execution,'latent',{get:()=>this.latent,set:value=>{this.latent=value;},configurable:true});
    let cursor=execution.cursor;
    Object.defineProperty(execution,'cursor',{get:()=>cursor,set:value=>{
      const was=cursor===null;
      cursor=value;
      if(was!==(value===null))frameChanged(this.instance);
    },configurable:true,enumerable:true});
    frameChanged(this.instance);
    return execution;
  }
  /** UObject::Serialize's load of the saved FStateFrame (the Node, StateNode, ProbeMask and LatentAction words, then the code offset when the
   * node is non-null; docs/travel.md "The .dxs"): the state, its probe mask, the code frame at `offset` in `codeNode`, and the latent action
   * the next ProcessState polls. The frame's local variables are not part of the file (the original's frame starts with its locals zeroed). */
  restoreFrame({stateNode,codeNode,probeMask,latentAction,offset}) {
    this.setStateNode(stateNode);
    this.probeMask=probeMask;
    this.latent=0;
    if(codeNode&&offset>=0){
      if(!codeNode.compiled.decoded.statements.has(offset))throw new Error('A saved state offset is not an instruction boundary');
      this.startFrame(codeNode,offset);
    }
    this.latent=latentAction;
    this.changedState=true;
  }
  /** Poll a pre-existing latent action before running statements. A native call
   * may install another latent action and must suspend until the next phase. */
  /** AActor::IsPendingKill (virtual +0x2c, body 0x1030df80): the actor's bDeleteMe; false for any other object. */
  destroyed() { return this.services.isPendingKill?.(this.instance)===true; }
  process(seconds) {
    // Engine 0x103e5b93-0x103e5b96 returns on null frame.Code before
    // inspecting LatentAction (+0x24), which InitExecution leaves untouched.
    if (!this.execution || this.execution.cursor === null) return;
    // 0x103e5bb3-0x103e5bb8: a destroyed actor's ProcessState returns here, before it polls its latent action.
    if(this.destroyed())return;
    if(this.latent===undefined)throw new Error('Original state latent slot is uninitialized before state entry');
    if(this.latent){
      if(!this.services.pollLatent)throw new Error(`Latent action ${this.latent} is not linked`);
      this.services.pollLatent({index:this.latent,receiver:this.instance,state:this,seconds});
      if(this.latent)return;
    }
    let changes=0;
    // 0x103e5c16-0x103e5c1a: bDeleteMe (Actor+0x28 bit 0x80) is tested before each opcode, so the statements after a Destroy() do not run (the VM loops
    // test it between statements of a state frame, script-vm.mjs resumeCompiled).
    while(this.execution && this.execution.cursor!==null && !this.latent && !this.destroyed()){
      if(++changes>64)throw new Error('VM state transition budget exceeded');
      const execution=this.execution;
      execution.resume();
      if(execution===this.execution)return;
    }
  }
}
/** ScriptState.prototype.process as defined here: the Rust actor tick skips
 * a ProcessState with no code to run only while it is unwrapped. */
export const originalProcess=ScriptState.prototype.process;
export const originalIsProbing=ScriptState.prototype.isProbing;
