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

export class ScriptState {
  constructor(instance, services = {}) {
    this.instance=instance;this.services=services;this.stateNode=null;
    this.execution=null;this.codeNode=null;this.latentAction=0;this.locals={};
    this.probeMask=[0,0];this.endingState=false;this.changedState=false;
  }
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
    this.probeWords=Object.freeze([...words]);
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
      }
      return true;
    }
    if(this.execution)this.execution.cursor=null;
    return false;
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
