/** Recovered Window background-texture and tile-colour setters used by InfoLink. */

const freeze=Object.freeze;
const functionEvidence=(packageExport,nativeIndex,serialSize,execBody,execEnd,execSha256,body,end,bodySha256)=>
  freeze({packageExport,nativeIndex,functionFlags:0x401,serialSize,scriptSize:5,
    execBody,execEnd,execSha256,body,end,bodySha256});

export const WINDOW_SURFACE_NATIVE=freeze({
  dll:'Extension.dll',dllSha256:'93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c',
  setBackground:functionEvidence(2109,1421,31,0x10051ce0,0x10051d26,
    'ea95cd12f671d47804314518cf39e0ff1010d61f2fff0c31b6fedcf8fad49b77',
    0x1004d5e0,0x1004d633,'6e55067a299e82a9647b171720bc58c84b4007630ff1b652e46245549722f0bf'),
  setTileColor:functionEvidence(1871,1475,30,0x10053ad0,0x10053b0c,
    'f2e8337d27082554b73cd09a4d46bbf96115a6e8d9a908c1362ab3b6ec1dfd33',
    0x1004dae0,0x1004db99,'a147ab8b337bfb4d44cd1fa208fa39f8c681329bcbe0dafc79c2d33464c53289'),
  gcSetTileColor:freeze({body:0x100274f0,end:0x10027574,
    bodySha256:'1c13dd8c6d93be627a7f1fca6476c998c534000d81b500425076d4d59919c8c6'}),
});

export const WINDOW_SURFACE_OFFSETS=freeze({
  packedTileColor:0x60,tilePlane:0x64,background:0xec,graphicsContext:0x130,
});
export const GC_SURFACE_OFFSETS=freeze({packedTileColor:0x54,tilePlane:0x58});

const sync=(value,label)=>{if(value&&typeof value.then==='function')throw new Error(`${label} suspended`);return value;};
const service=(services,name)=>{if(typeof services?.[name]!=='function')throw new Error(`Window surface requires ${name} service`);return services[name];};
const canonical=(value,label,{nullable=false}={})=>{
  if(nullable&&(value===null||value===0))return value;
  if(value===null||value===undefined||value===0||
    (typeof value!=='object'&&typeof value!=='function'&&typeof value!=='number'))
    throw new Error(`Window surface requires canonical ${label}`);
  return value;
};
const readRaw=(object,offset,kind,services,phase)=>sync(service(services,'read')(object,offset,kind,
  {native:phase.native,phase:phase.name,offset,kind}),`${phase.name} read +0x${offset.toString(16)}`);
const writeRaw=(object,offset,kind,value,services,phase)=>sync(service(services,'write')(object,offset,kind,value,
  {native:phase.native,phase:phase.name,offset,kind,value}),`${phase.name} write +0x${offset.toString(16)}`);
const askParent=(object,services,caller)=>sync(service(services,'askParentForReconfigure')({
  object,native:0x1004e060,caller,
}),'Window surface AskParentForReconfigure');
const byte=(value,label)=>{if(!Number.isInteger(value)||value<0||value>255)throw new Error(`${label} requires a byte`);return value;};
const colorChannels=value=>{
  if(!value||typeof value!=='object')throw new Error('Window.SetTileColor requires Core.Object.Color');
  return ['r','g','b','a'].map(channel=>byte(value[`core.object.color.${channel}`]??value[channel],`Color.${channel}`));
};
const packedColor=c=>(c[0]|c[1]<<8|c[2]<<16|c[3]<<24)>>>0;
const colorPlane=c=>[Math.fround(c[0]/255),Math.fround(c[1]/255),Math.fround(c[2]/255),0];
function writePlane(object,offset,values,services,phase){
  for(let index=0;index<4;index++)writeRaw(object,offset+index*4,'f32',values[index],services,phase);
}

/** XWindow::SetBackground's identity guard, pointer store and reconfigure call. */
export function setWindowBackgroundNative(window,background,services={}){
  const object=canonical(window,'Window'),value=canonical(background,'background texture',{nullable:true});
  const phase={native:WINDOW_SURFACE_NATIVE.setBackground.body,name:'XWindow::SetBackground'};
  const previous=readRaw(object,WINDOW_SURFACE_OFFSETS.background,'ptr',services,phase);
  if(previous===value)return false;
  writeRaw(object,WINDOW_SURFACE_OFFSETS.background,'ptr',value,services,phase);
  askParent(object,services,phase.native);return true;
}

/** XGC::SetTileColor's packed Color and normalized RGB plane stores. */
export function setGcTileColorNative(graphicsContext,newColor,services={}){
  const object=canonical(graphicsContext,'XGC'),channels=colorChannels(newColor);
  const phase={native:WINDOW_SURFACE_NATIVE.gcSetTileColor.body,name:'XGC::SetTileColor'};
  writeRaw(object,GC_SURFACE_OFFSETS.packedTileColor,'u32',packedColor(channels),services,phase);
  writePlane(object,GC_SURFACE_OFFSETS.tilePlane,colorPlane(channels),services,phase);
}

/** XWindow::SetTileColor writes the Window fields, then mirrors into nullable XGC. */
export function setWindowTileColorNative(window,newColor,services={}){
  const object=canonical(window,'Window'),channels=colorChannels(newColor);
  const phase={native:WINDOW_SURFACE_NATIVE.setTileColor.body,name:'XWindow::SetTileColor'};
  writeRaw(object,WINDOW_SURFACE_OFFSETS.packedTileColor,'u32',packedColor(channels),services,phase);
  writePlane(object,WINDOW_SURFACE_OFFSETS.tilePlane,colorPlane(channels),services,phase);
  const gc=readRaw(object,WINDOW_SURFACE_OFFSETS.graphicsContext,'ptr',services,phase);
  if(gc)setGcTileColorNative(gc,newColor,services);
  return {packed:packedColor(channels),graphicsContext:gc??null};
}
