/** Recovered Window.Raise and Window.Hide wrappers used by StaticWindow. */
import {setVisibilityNative} from './script-window-visibility.mjs';

export const WINDOW_ORDER_NATIVE=Object.freeze({
  dll:'Extension.dll',dllSha256:'93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c',
  raise:Object.freeze({packageExport:2122,nativeIndex:1411,functionFlags:0x401,serialSize:27,
    execBody:0x10051900,execEnd:0x10051910,execSha256:'d999f766d35efe188551a068032377f30409c94b30b133d553b95ed63df2210e',
    body:0x1004c250,end:0x1004c2b5,bodySha256:'a9bbcef9c6784f6df20b2ac016463e8624f6ef2488135e5f049a8faf08522605'}),
  hide:Object.freeze({packageExport:2091,nativeIndex:1414,functionFlags:0x401,serialSize:27,
    execBody:0x100519d0,execEnd:0x100519e1,execSha256:'365e02fb2867d235f860ad813ed2a6a929bdacf77e798d33b5630a186c12e4cd',
    body:0x100031b0,end:0x100031b8,bodySha256:'620a4020fd7d3b9f572a2bd869b2ad4c7ff7a852d9fbf3c9464fdb034e76adc8'}),
});

export const WINDOW_ORDER_OFFSETS=Object.freeze({parent:0x138,nextSibling:0x148});

const sync=(value,label)=>{if(value&&typeof value.then==='function')throw new Error(`Window.${label} suspended`);return value;};
const service=(services,name)=>{if(typeof services?.[name]!=='function')throw new Error(`Window.Raise requires ${name} service`);return services[name];};
const canonical=(value,label,{nullable=false}={})=>{
  if(nullable&&(value===null||value===0))return value;
  if(!value||(typeof value!=='object'&&typeof value!=='function'&&typeof value!=='number'))
    throw new Error(`Window.Raise requires canonical ${label}`);
  return value;
};

/** Execute XWindow::Raise. AddChild owns the exact sibling relink operation. */
export function raiseWindowNative(object,services={}){
  const window=canonical(object,'Window');
  const read=service(services,'read');
  const parent=canonical(sync(read(window,WINDOW_ORDER_OFFSETS.parent,'ptr',{
    native:WINDOW_ORDER_NATIVE.raise.body,phase:'Raise/parent'}),'Raise parent read'),'parent',{nullable:true});
  if(!parent)return false;
  const next=canonical(sync(read(window,WINDOW_ORDER_OFFSETS.nextSibling,'ptr',{
    native:WINDOW_ORDER_NATIVE.raise.body,phase:'Raise/next-sibling'}),'Raise sibling read'),'next sibling',{nullable:true});
  if(!next)return false;
  sync(service(services,'addChild')({parent,child:window,flag:1,native:0x10050a80}),'Raise AddChild');
  sync(service(services,'askParentForReconfigure')({object:window,native:0x1004e060}),'Raise AskParentForReconfigure');
  sync(service(services,'checkFocusWindow')({object:window,native:0x10050b80}),'Raise CheckFocusWindow');
  return true;
}

/** execHide increments the frame then calls XWindow::SetVisibility(this,0). */
export function hideWindowNative(object,services={}){
  canonical(object,'Window');
  return setVisibilityNative({object,visible:false},services);
}
