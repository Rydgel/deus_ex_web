/** FStateFrame code/latent continuation. Class lookup and BeginState/EndState
 * dispatch are owned by the object runtime; this layer executes resolved states.
 * Original GotoLabel1012eb10 and ProcessState103e5b60: see docs/door-state.md. */
export class ScriptState {
  constructor(instance, services = {}) {
    this.instance=instance;this.services=services;this.stateNode=null;
    this.execution=null;this.codeNode=null;this.latent=0;this.locals={};
    this.probeMask=[0,0];this.endingState=false;this.changedState=false;
  }
  /** A linked node has {compiled, labels:Map<lowercase name,offset>, base}. */
  setStateNode(node) {
    if(this.execution)this.execution.cursor=null;
    this.stateNode=node;this.execution=null;this.codeNode=null;this.latent=0;
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
        this.execution=node.compiled.createFrame(this.instance,this.locals,this.services,{offset,state:true});
        this.codeNode=node;
        Object.defineProperty(this.execution,'latent',{get:()=>this.latent,set:value=>{this.latent=value;},configurable:true});
      }
      return true;
    }
    if(this.execution)this.execution.cursor=null;
    return false;
  }
  /** Poll a pre-existing latent action before running statements. A native call
   * may install another latent action and must suspend until the next phase. */
  process(seconds) {
    // Engine 0x103e5b93-0x103e5b96 returns on null frame.Code before
    // inspecting LatentAction (+0x24), which InitExecution leaves untouched.
    if (!this.execution || this.execution.cursor === null) return;
    if(this.latent===undefined)throw new Error('Original state latent slot is uninitialized before state entry');
    if(this.latent){
      if(!this.services.pollLatent)throw new Error(`Latent action ${this.latent} is not linked`);
      this.services.pollLatent({index:this.latent,receiver:this.instance,state:this,seconds});
      if(this.latent)return;
    }
    let changes=0;
    while(this.execution && this.execution.cursor!==null && !this.latent){
      if(++changes>64)throw new Error('VM state transition budget exceeded');
      const execution=this.execution;
      execution.resume();
      if(execution===this.execution)return;
    }
  }
}
