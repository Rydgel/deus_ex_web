/** Recovered XTextWindow Init and the text setters used by InfoLink. */
import {setWindowGcFontsNative} from './script-window-construction.mjs';

const freeze=value=>Object.freeze(value);

const functionEvidence=(packageExport,nativeIndex,serialSize,execBody,execEnd,execSha256,body,end,bodySha256)=>
  freeze({packageExport,nativeIndex,functionFlags:0x401,serialSize,execBody,execEnd,execSha256,body,end,bodySha256});

export const WINDOW_TEXT_NATIVE=freeze({
  dll:'Extension.dll',dllSha256:'93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c',
  textConstructor:freeze({body:0x10008e70,end:0x10008ea9,
    bodySha256:'47d024c7efdd8f3fb688fa8b906f6be13bd8f535fd730ac47623872fc2dcdb35'}),
  textInit:freeze({body:0x10045af0,end:0x10045bf2,
    bodySha256:'5bb6ab6976bd1d499717188bbd14b2ecae6d4cfdbab4bf50999df30f89d2e49f'}),
  setText:functionEvidence(1146,1550,30,0x10046a30,0x10046b52,
    '3c1f02b64713f96f82539033b58ca16a7125974d12964ad16cb8c065c156da64',
    0x10045d50,0x10045e2a,'a84bc56acde8c1e4848a77d3cde089eac8dd0aa624ac77121f15e7a41f2fca4d'),
  appendText:functionEvidence(1145,1551,30,0x10046b80,0x10046ca2,
    '15af77095711e7413be90b522f8cf7c27f504c09e8807847c8761a456047cc1d',
    0x10045e60,0x10045f74,'075f6ec2309035b4a3323f9b2695e92055e9f71279fc3e912617d4fbeec11bbd'),
  setTextAlignments:functionEvidence(1125,1556,34,0x10047000,0x10047075,
    '368e31dc383ea33d54616cd3a0a8e675651408880f46a7dae611b44bb807480b',
    0x10046050,0x10046067,'c90f05e91d2fa5a45dbe4e0ebc70888d109670ff89245345c6b6d2d3c3d29a71'),
  setTextMargins:functionEvidence(1122,1557,34,0x100470a0,0x1004710f,
    '77e34c75deba84a484ee009b51ebdea378824d6c142a0017262f999c867fe2b5',
    0x10046070,0x100460e2,'8496a3ce40e7c1f0d7edd521d0821139a36d2ca58a3ec7cb0373bacc94b24f53'),
  setFont:functionEvidence(1856,1477,30,0x10053b90,0x10053bd6,
    '7fb42a956728393d07ba4a8fe14903c59666d071fb82620e8c8a74cf6274fa3a',
    0x1004d840,0x1004d885,'dbf4e8141c985fb9df1f1a46f823959a5ef6f81bcaf95b680c720f4b73a72808'),
  setTextColor:functionEvidence(1854,1476,30,0x10053b30,0x10053b6c,
    '2493740e53d84eeab7288bc087299f489c23896f20b3c81c4e6055f4fb6c172b',
    0x1004d9e0,0x1004da99,'cac0aae31ab5b1e3612f9fff38316412506740d5f9fd0a2b8477eae88c564ece'),
  gcSetTextColor:freeze({body:0x10027580,end:0x10027604,
    bodySha256:'701d17cb1c23d8dd728e607816b3c535ebc646d44e022b7f4a1d77c9b3d807a0'}),
  enableTextAsAccelerator:freeze({body:0x100464e0,end:0x10046564,
    bodySha256:'d52a2b5d3313f2b557f676e7a60defae0c0e75b632105874f6f7e8ab2aa7ab98'}),
  setAcceleratorText:freeze({body:0x1004f310,end:0x1004f37d,
    bodySha256:'3f24b63590822bb14a2e7d02b63d8e9cf1ed26f73a0328a7b3b2a85d5595983c'}),
  setAcceleratorKey:freeze({body:0x1004f3b0,end:0x1004f410,
    bodySha256:'c94849fff52ab02f100bfa2cde9cd661690f4b7ea5de63b13eefa38b8df686f2'}),
});

export const WINDOW_TEXT_OFFSETS=freeze({
  packedTextColor:0x3d,textPlane:0x44,normalFont:0x54,boldFont:0x58,
  acceleratorKey:0xb4,graphicsContext:0x130,
  horizontalAlignment:0x14c,verticalAlignment:0x14d,textFlags:0x150,
  horizontalMargin:0x154,verticalMargin:0x158,minLines:0x15c,maxLines:0x160,
  minWidth:0x164,text:0x168,
});

export const GC_TEXT_OFFSETS=freeze({packedTextColor:0x68,textPlane:0x6c});
export const TEXT_WINDOW_FLAGS=freeze({wordWrap:1,textIsAccelerator:2});

const sync=(value,label)=>{if(value&&typeof value.then==='function')throw new Error(`${label} suspended`);return value;};
const service=(services,name)=>{if(typeof services?.[name]!=='function')throw new Error(`Window text requires ${name} service`);return services[name];};
const canonical=(value,label,{nullable=false}={})=>{
  if(nullable&&(value===null||value===0))return value;
  if(value===null||value===undefined||value===0||
    (typeof value!=='object'&&typeof value!=='function'&&typeof value!=='number'))
    throw new Error(`Window text requires canonical ${label}`);
  return value;
};
const readRaw=(object,offset,kind,services,phase)=>sync(service(services,'read')(object,offset,kind,
  {native:phase.native,phase:phase.name,offset,kind}),`${phase.name} read +0x${offset.toString(16)}`);
const writeRaw=(object,offset,kind,value,services,phase)=>sync(service(services,'write')(object,offset,kind,value,
  {native:phase.native,phase:phase.name,offset,kind,value}),`${phase.name} write +0x${offset.toString(16)}`);
const askParent=(object,services,native)=>sync(service(services,'askParentForReconfigure')({object,native:0x1004e060,caller:native}),
  'Window text AskParentForReconfigure');
const byte=(value,label)=>{if(!Number.isInteger(value)||value<0||value>255)throw new Error(`${label} requires a byte`);return value;};
const scalar=(value,label)=>{if(typeof value!=='number')throw new Error(`${label} requires a float`);return Math.fround(value);};
const textValue=(value,label)=>{if(typeof value!=='string')throw new Error(`${label} requires an initialized string`);return value;};
const present=value=>value!==null&&value!==0;

function asciiFold(code){return code>=65&&code<=90?code+32:code;}
export function originalTextEqual(left,right){
  const a=textValue(left,'appStricmp left'),b=textValue(right,'appStricmp right');
  if(a.length!==b.length)return false;
  for(let index=0;index<a.length;index++){
    const x=a.charCodeAt(index),y=b.charCodeAt(index);
    if(x>127||y>127)throw new Error('Window text appStricmp non-ASCII branch is not recovered');
    if(asciiFold(x)!==asciiFold(y))return false;
  }
  return true;
}

function colorChannels(value){
  if(!value||typeof value!=='object')throw new Error('Window.SetTextColor requires Core.Object.Color');
  return ['r','g','b','a'].map(channel=>byte(value[`core.object.color.${channel}`]??value[channel],`Color.${channel}`));
}
function packedColor(channels){return (channels[0]|channels[1]<<8|channels[2]<<16|channels[3]<<24)>>>0;}
function plane(channels){return [Math.fround(channels[0]/255),Math.fround(channels[1]/255),Math.fround(channels[2]/255),0];}
function writePlane(object,offset,values,services,phase){
  for(let index=0;index<4;index++)writeRaw(object,offset+index*4,'f32',values[index],services,phase);
}

/** XGC::SetTextColor stores the packed Color then its normalized RGB plane. */
export function setGcTextColorNative(graphicsContext,newColor,services={}){
  const gc=canonical(graphicsContext,'XGC'),channels=colorChannels(newColor);
  const phase={native:WINDOW_TEXT_NATIVE.gcSetTextColor.body,name:'XGC::SetTextColor'};
  writeRaw(gc,GC_TEXT_OFFSETS.packedTextColor,'u32',packedColor(channels),services,phase);
  writePlane(gc,GC_TEXT_OFFSETS.textPlane,plane(channels),services,phase);
}

/** XWindow::SetTextColor used by winName. */
export function setWindowTextColorNative(window,newColor,services={}){
  const object=canonical(window,'Window'),channels=colorChannels(newColor);
  const phase={native:WINDOW_TEXT_NATIVE.setTextColor.body,name:'XWindow::SetTextColor'};
  writeRaw(object,WINDOW_TEXT_OFFSETS.packedTextColor,'u32',packedColor(channels),services,phase);
  const gc=readRaw(object,WINDOW_TEXT_OFFSETS.graphicsContext,'ptr',services,phase);
  writePlane(object,WINDOW_TEXT_OFFSETS.textPlane,plane(channels),services,phase);
  if(present(gc))setGcTextColorNative(gc,newColor,services);
}

/** XWindow::SetFont delegates to SetFonts(font,font). */
export function setWindowFontNative(window,font,services={}){
  const object=canonical(window,'Window'),value=canonical(font,'Font',{nullable:true});
  const phase={native:WINDOW_TEXT_NATIVE.setFont.body,name:'XWindow::SetFont'};
  const gc=readRaw(object,WINDOW_TEXT_OFFSETS.graphicsContext,'ptr',services,phase);
  writeRaw(object,WINDOW_TEXT_OFFSETS.normalFont,'ptr',value,services,phase);
  writeRaw(object,WINDOW_TEXT_OFFSETS.boldFont,'ptr',value,services,phase);
  if(present(gc))setWindowGcFontsNative({graphicsContext:gc,normalFont:value,boldFont:value},services);
  askParent(object,services,phase.native);
}

/** XTextWindow::SetTextAlignments is two unconditional byte stores. */
export function setTextAlignmentsNative(window,horizontal,vertical,services={}){
  const object=canonical(window,'TextWindow');
  const phase={native:WINDOW_TEXT_NATIVE.setTextAlignments.body,name:'XTextWindow::SetTextAlignments'};
  writeRaw(object,WINDOW_TEXT_OFFSETS.horizontalAlignment,'u8',byte(horizontal,'horizontal alignment'),services,phase);
  writeRaw(object,WINDOW_TEXT_OFFSETS.verticalAlignment,'u8',byte(vertical,'vertical alignment'),services,phase);
}

function equalOrUnordered(left,right){return Number.isNaN(left)||Number.isNaN(right)||Object.is(left,right)||left===right;}

/** XTextWindow::SetTextMargins preserves x87 equal/unordered branch behavior. */
export function setTextMarginsNative(window,horizontal,vertical,services={}){
  const object=canonical(window,'TextWindow'),h=scalar(horizontal,'horizontal margin'),v=scalar(vertical,'vertical margin');
  const phase={native:WINDOW_TEXT_NATIVE.setTextMargins.body,name:'XTextWindow::SetTextMargins'};
  const oldH=readRaw(object,WINDOW_TEXT_OFFSETS.horizontalMargin,'f32',services,phase);
  if(equalOrUnordered(oldH,h)){
    const oldV=readRaw(object,WINDOW_TEXT_OFFSETS.verticalMargin,'f32',services,phase);
    if(equalOrUnordered(oldV,v))return false;
  }
  writeRaw(object,WINDOW_TEXT_OFFSETS.horizontalMargin,'f32',h,services,phase);
  writeRaw(object,WINDOW_TEXT_OFFSETS.verticalMargin,'f32',v,services,phase);
  askParent(object,services,phase.native);
  return true;
}

/** XWindow::SetAcceleratorKey's byte-range guard and dirty-table callback. */
export function setAcceleratorKeyNative(window,key,services={}){
  const object=canonical(window,'Window');
  if(!Number.isInteger(key)||key<0||key>0xffff)throw new Error('accelerator key requires a uint16');
  const phase={native:WINDOW_TEXT_NATIVE.setAcceleratorKey.body,name:'XWindow::SetAcceleratorKey'};
  const value=key<0xff?key:0;
  const old=readRaw(object,WINDOW_TEXT_OFFSETS.acceleratorKey,'u32',services,phase);
  writeRaw(object,WINDOW_TEXT_OFFSETS.acceleratorKey,'u32',value,services,phase);
  if(old!==value)sync(service(services,'makeAcceleratorTableDirty')({object,key:value}),phase.name);
  return value;
}

/** XWindow::SetAcceleratorText 0x1004f310 scans UTF-16 units for "|&". A '|'
 * whose next unit is not '&' also consumes that unit (0x1004f34f then
 * 0x1004f378 each add 2), so "||&k" yields no key. A final '|' steps past the
 * terminator into unrelated heap bytes; that read is not reproduced. */
export function setAcceleratorTextNative(window,value,services={}){
  const text=value===null?'':textValue(value,'accelerator text').split('\0',1)[0];
  let key=0;
  for(let index=0;index<text.length;){
    if(text.charCodeAt(index++)!==0x7c)continue;
    if(index===text.length)throw new Error('XWindow::SetAcceleratorText reads past the terminator after a final "|"');
    if(text.charCodeAt(index++)!==0x26)continue;
    key=text.charCodeAt(index)||0;break;
  }
  return setAcceleratorKeyNative(window,key,services);
}

/** XTextWindow::EnableTextAsAccelerator used by its native Init. */
export function enableTextAsAcceleratorNative(window,enabled,services={}){
  const object=canonical(window,'TextWindow');
  if(!Number.isInteger(enabled))throw new Error('EnableTextAsAccelerator requires an integer boolean');
  const phase={native:WINDOW_TEXT_NATIVE.enableTextAsAccelerator.body,name:'XTextWindow::EnableTextAsAccelerator'};
  const flags=readRaw(object,WINDOW_TEXT_OFFSETS.textFlags,'u32',services,phase)>>>0;
  if(((flags>>>1)&1)===enabled)return false;
  const next=((flags&~TEXT_WINDOW_FLAGS.textIsAccelerator)|((enabled&1)<<1))>>>0;
  writeRaw(object,WINDOW_TEXT_OFFSETS.textFlags,'u32',next,services,phase);
  const text=next&TEXT_WINDOW_FLAGS.textIsAccelerator
    ?readRaw(object,WINDOW_TEXT_OFFSETS.text,'string',services,phase):null;
  setAcceleratorTextNative(object,text,services);
  return true;
}

/** XTextWindow::Init after its XWindow::Init base call. */
export function initTextWindowNative(window,parent,services={}){
  const object=canonical(window,'TextWindow'),parentObject=canonical(parent,'parent',{nullable:true});
  sync(service(services,'initWindow')({window:object,parent:parentObject}),'XTextWindow::Init base Init');
  const phase={native:WINDOW_TEXT_NATIVE.textInit.body,name:'XTextWindow::Init'};
  writeRaw(object,WINDOW_TEXT_OFFSETS.horizontalMargin,'f32',3,services,phase);
  writeRaw(object,WINDOW_TEXT_OFFSETS.verticalMargin,'f32',3,services,phase);
  writeRaw(object,WINDOW_TEXT_OFFSETS.minWidth,'f32',0,services,phase);
  const flags=readRaw(object,WINDOW_TEXT_OFFSETS.textFlags,'u32',services,phase)>>>0;
  writeRaw(object,WINDOW_TEXT_OFFSETS.horizontalAlignment,'u8',1,services,phase);
  writeRaw(object,WINDOW_TEXT_OFFSETS.verticalAlignment,'u8',1,services,phase);
  writeRaw(object,WINDOW_TEXT_OFFSETS.textFlags,'u32',(flags|TEXT_WINDOW_FLAGS.wordWrap)>>>0,services,phase);
  writeRaw(object,WINDOW_TEXT_OFFSETS.minLines,'i32',-1,services,phase);
  writeRaw(object,WINDOW_TEXT_OFFSETS.maxLines,'i32',-1,services,phase);
  writeRaw(object,WINDOW_TEXT_OFFSETS.text,'string','',services,phase);
  enableTextAsAcceleratorNative(object,1,services);
  return object;
}

/** XWindow::ConvertScriptString (0x10050710), applied by the SetText and
 * AppendText execs before their virtual call: the C string is scanned in
 * UTF-16 pairs; "|n" becomes LF and any other "|" pair stays literal, as does
 * a final "|". */
export function convertScriptString(value){
  const text=String(value).split('\0',1)[0];let result='';
  for(let index=0;index<text.length;index++){
    const unit=text[index];
    if(unit!=='|'){result+=unit;continue;}
    const next=text[++index];result+=next==='n'?'\n':('|'+(next??''));
  }
  return result;
}

/** XTextWindow::AppendText (0x10045e60): append the C string to the text
 * FString, re-derive the accelerator from the whole text when the text is an
 * accelerator, and always ask the parent to reconfigure. */
export function appendTextNative(window,newText,services={}){
  const object=canonical(window,'TextWindow'),value=textValue(newText,'TextWindow.AppendText').split('\0',1)[0];
  const phase={native:WINDOW_TEXT_NATIVE.appendText.body,name:'XTextWindow::AppendText'};
  const current=readRaw(object,WINDOW_TEXT_OFFSETS.text,'string',services,phase);
  const text=textValue(current,'TextWindow text')+value;
  if(typeof services.realloc==='function')appendRaw(object,value,services,phase);
  else if(text!==current)writeRaw(object,WINDOW_TEXT_OFFSETS.text,'string',text,services,phase);
  const flags=readRaw(object,WINDOW_TEXT_OFFSETS.textFlags,'u32',services,phase)>>>0;
  if(flags&TEXT_WINDOW_FLAGS.textIsAccelerator)setAcceleratorTextNative(object,text.split('\0',1)[0],services);
  askParent(object,services,phase.native);
  return true;
}

/** The FString operator+= of 0x10045e60 over the raw Data/Num/Max words when
 * the host supplies GMalloc (`services.realloc`): Num grows by the length
 * (the copy lands on the old NUL), or an empty FString takes length + 1 only
 * for a non-empty text; Max becomes num + 3*num/8 + 32 when exceeded
 * (FArray::Realloc). */
function appendRaw(object,value,services,phase){
  const at=WINDOW_TEXT_OFFSETS.text,num=readRaw(object,at+4,'i32',services,phase)|0,length=value.length;
  if(!num&&!length)return;
  const next=num?num+length:length+1,start=num?num-1:0;
  writeRaw(object,at+4,'i32',next,services,phase);
  if(next>(readRaw(object,at+8,'i32',services,phase)|0)){
    const max=next+((next*3)>>3)+0x20;
    writeRaw(object,at+8,'i32',max,services,phase);
    writeRaw(object,at,'u32',services.realloc(readRaw(object,at,'u32',services,phase)>>>0,max*2),services,phase);
  }
  const data=readRaw(object,at,'u32',services,phase)>>>0;
  for(let i=0;i<length;i++)services.write(data,2*(start+i),'u16',value.charCodeAt(i));
  services.write(data,2*(start+length),'u16',0);
}

/** XTextWindow::SetText's case-insensitive unchanged guard and callbacks. */
export function setTextNative(window,newText,services={}){
  const object=canonical(window,'TextWindow'),value=textValue(newText,'TextWindow.SetText');
  const phase={native:WINDOW_TEXT_NATIVE.setText.body,name:'XTextWindow::SetText'};
  const current=readRaw(object,WINDOW_TEXT_OFFSETS.text,'string',services,phase);
  const equal=services.equalIgnoreCase??originalTextEqual;
  if(sync(equal(current,value),phase.name))return false;
  writeRaw(object,WINDOW_TEXT_OFFSETS.text,'string',value,services,phase);
  const flags=readRaw(object,WINDOW_TEXT_OFFSETS.textFlags,'u32',services,phase)>>>0;
  if(flags&TEXT_WINDOW_FLAGS.textIsAccelerator)setAcceleratorTextNative(object,value,services);
  askParent(object,services,phase.native);
  return true;
}
