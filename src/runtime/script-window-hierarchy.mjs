/** Original Extension GetRootWindow1004c5a0. Raw offsets intentionally keep
 * the native hierarchy distinct from UObject.Outer and script class identity.
 * Evidence and unsupported inputs: docs/script-window-hierarchy.md. */
export function getRootWindowNative(object,{readParent,readType}={}) {
  if(typeof readParent!=='function'||typeof readType!=='function')
    throw new Error('GetRootWindow requires native parent+138/type+28 readers');
  const seen=new Set();
  for(;;){
    if(!object||typeof object!=='object'||seen.has(object))
      throw new Error('GetRootWindow received an unresolved or cyclic native window hierarchy');
    seen.add(object);
    const parent=readParent(object);
    if(parent&&typeof parent.then==='function')throw new Error('GetRootWindow parent read suspended');
    if(parent===null)break;
    object=parent;
  }
  const type=readType(object);
  if(!Number.isInteger(type)||type<0||type>255)
    throw new Error('GetRootWindow requires the original unsigned type byte');
  return type>=3?object:null;
}

function pointers({read,write}={}) {
  if(typeof read!=='function'||typeof write!=='function')
    throw new Error('Window child links require native pointer read/write services');
  const reference=value=>{
    if(value!==null&&(!value||typeof value!=='object'||typeof value.then==='function'))
      throw new Error('Window child link is not a resolved native pointer');
    return value;
  };
  return {
    read:(object,offset)=>reference(read(reference(object),offset)),
    write:(object,offset,value)=>{
      const result=write(reference(object),offset,reference(value));
      if(result&&typeof result.then==='function')throw new Error('Window child link write suspended');
    },
  };
}

/** XWindow::RemoveChild10050a00; this helper does not dispatch callbacks. */
export function removeWindowChildNative(parent,child,services) {
  if(child===null)return;
  const {read,write}=pointers(services);
  const lower=read(child,0x144);
  if(lower!==null)write(lower,0x148,read(child,0x148));
  else write(parent,0x13c,read(child,0x148));
  const higher=read(child,0x148);
  if(higher!==null)write(higher,0x144,read(child,0x144));
  else write(parent,0x140,read(child,0x144));
  write(child,0x148,null);
  write(child,0x144,null);
  write(child,0x138,null);
}

/** XWindow::AddChild10050a80, including original prior-parent removal. */
export function addWindowChildNative(parent,child,front,services) {
  if(child===null)return;
  if(!Number.isInteger(front))throw new Error('Window.AddChild requires an integer front selector');
  const {read,write}=pointers(services);
  const previous=read(child,0x138);
  if(previous!==null)removeWindowChildNative(previous,child,services);
  if(front!==0){
    const endpoint=read(parent,0x140);
    write(child,0x148,null);
    write(child,0x144,endpoint);
    const current=read(parent,0x140);
    if(current===null)write(parent,0x13c,child);
    else write(current,0x148,child);
    write(parent,0x140,child);
  }else{
    write(child,0x144,null);
    write(child,0x148,read(parent,0x13c));
    const current=read(parent,0x13c);
    if(current===null)write(parent,0x140,child);
    else write(current,0x144,child);
    write(parent,0x13c,child);
  }
  write(child,0x138,parent);
}
