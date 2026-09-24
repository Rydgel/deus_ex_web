/** Focused installed-metadata/hash and semantic validation for InfoLink winName. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {readFunctionMetadata} from '../src/unreal/script-metadata.mjs';
import {
  WINDOW_TEXT_NATIVE,WINDOW_TEXT_OFFSETS,GC_TEXT_OFFSETS,
  initTextWindowNative,setTextAlignmentsNative,setTextMarginsNative,
  setWindowFontNative,setWindowTextColorNative,setTextNative,appendTextNative,convertScriptString,
} from '../src/runtime/script-window-text.mjs';
import {gameDirectory} from './game-directory.mjs';

const root=gameDirectory(),system=path.join(root,'System');
const assets=new AssetStore((await readdir(system)).map(name=>({path:`System/${name}`,read:()=>readFile(path.join(system,name))})));
const extension=await assets.get('Extension');
const functions=[
  ['textwindow.settext',WINDOW_TEXT_NATIVE.setText,['string']],
  ['textwindow.appendtext',WINDOW_TEXT_NATIVE.appendText,['string']],
  ['textwindow.settextalignments',WINDOW_TEXT_NATIVE.setTextAlignments,['byte','byte']],
  ['textwindow.settextmargins',WINDOW_TEXT_NATIVE.setTextMargins,['float','float']],
  ['window.setfont',WINDOW_TEXT_NATIVE.setFont,['object']],
  ['window.settextcolor',WINDOW_TEXT_NATIVE.setTextColor,['struct']],
];
for(const [name,evidence,parameterTypes] of functions){
  const index=extension.exportsByPath.get(name),metadata=readFunctionMetadata(extension,index);
  assert.equal(index,evidence.packageExport);assert.equal(metadata.nativeIndex,evidence.nativeIndex);
  assert.equal(metadata.functionFlags,evidence.functionFlags);assert.equal(metadata.entry.serialSize,evidence.serialSize);
  assert.deepEqual(metadata.parameters.map(parameter=>parameter.type),parameterTypes);
}

const dll=new Uint8Array(await readFile(path.join(system,'Extension.dll'))),base=0x10000000;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
assert.equal(sha(dll),WINDOW_TEXT_NATIVE.dllSha256);
for(const evidence of Object.values(WINDOW_TEXT_NATIVE)){
  if(!evidence||typeof evidence!=='object'||!evidence.body)continue;
  assert.equal(sha(dll.subarray(evidence.body-base,evidence.end-base)),evidence.bodySha256);
  if(evidence.execBody)assert.equal(sha(dll.subarray(evidence.execBody-base,evidence.execEnd-base)),evidence.execSha256);
}

function memoryFixture(){
  const values=new WeakMap(),events=[];
  const fields=object=>{if(!values.has(object))values.set(object,new Map());return values.get(object);};
  const read=(object,offset,kind)=>{events.push(['read',object,offset,kind]);return fields(object).has(offset)?fields(object).get(offset):kind==='ptr'?null:0;};
  const write=(object,offset,kind,value)=>{events.push(['write',object,offset,kind,value]);fields(object).set(offset,value);};
  return {values,events,fields,read,write};
}

const window={},parent={},gc={},font={},m=memoryFixture(),dirty=[],reconfigure=[];
m.fields(window).set(WINDOW_TEXT_OFFSETS.textFlags,0x80000000);
m.fields(window).set(WINDOW_TEXT_OFFSETS.acceleratorKey,0);
initTextWindowNative(window,parent,{read:m.read,write:m.write,
  initWindow:request=>{assert.deepEqual(request,{window,parent});m.events.push(['XWindow::Init']);},
  makeAcceleratorTableDirty:request=>dirty.push(request),
});
assert.equal(m.fields(window).get(WINDOW_TEXT_OFFSETS.horizontalAlignment),1);
assert.equal(m.fields(window).get(WINDOW_TEXT_OFFSETS.verticalAlignment),1);
assert.equal(m.fields(window).get(WINDOW_TEXT_OFFSETS.textFlags),0x80000003);
assert.equal(m.fields(window).get(WINDOW_TEXT_OFFSETS.horizontalMargin),3);
assert.equal(m.fields(window).get(WINDOW_TEXT_OFFSETS.verticalMargin),3);
assert.equal(m.fields(window).get(WINDOW_TEXT_OFFSETS.minLines),-1);
assert.equal(m.fields(window).get(WINDOW_TEXT_OFFSETS.maxLines),-1);
assert.equal(m.fields(window).get(WINDOW_TEXT_OFFSETS.minWidth),0);
assert.equal(m.fields(window).get(WINDOW_TEXT_OFFSETS.text),'');
assert.equal(m.fields(window).get(WINDOW_TEXT_OFFSETS.acceleratorKey),0);
assert.deepEqual(dirty,[]);

const services={read:m.read,write:m.write,
  askParentForReconfigure:request=>reconfigure.push(request),
  makeAcceleratorTableDirty:request=>dirty.push(request)};
setTextAlignmentsNative(window,0,1,services);
assert.equal(m.fields(window).get(WINDOW_TEXT_OFFSETS.horizontalAlignment),0);
assert.equal(m.fields(window).get(WINDOW_TEXT_OFFSETS.verticalAlignment),1);
assert.equal(setTextMarginsNative(window,3,3,services),false);
assert.equal(reconfigure.length,0);
assert.equal(setTextMarginsNative(window,0,0,services),true);
assert.equal(m.fields(window).get(WINDOW_TEXT_OFFSETS.horizontalMargin),0);
assert.equal(m.fields(window).get(WINDOW_TEXT_OFFSETS.verticalMargin),0);
assert.equal(reconfigure.length,1);
assert.equal(setTextMarginsNative(window,Number.NaN,0,services),false,'x87 unordered C3 follows the equal branch');

m.fields(window).set(WINDOW_TEXT_OFFSETS.graphicsContext,gc);
setWindowFontNative(window,font,services);
assert.equal(m.fields(window).get(WINDOW_TEXT_OFFSETS.normalFont),font);
assert.equal(m.fields(window).get(WINDOW_TEXT_OFFSETS.boldFont),font);
assert.equal(m.fields(gc).get(0x7c),font);assert.equal(m.fields(gc).get(0x80),font);
assert.equal(reconfigure.length,2);

const color={'core.object.color.r':255,'core.object.color.g':128,'core.object.color.b':0,'core.object.color.a':7};
setWindowTextColorNative(window,color,services);
assert.equal(m.fields(window).get(WINDOW_TEXT_OFFSETS.packedTextColor),0x070080ff);
assert.equal(m.fields(gc).get(GC_TEXT_OFFSETS.packedTextColor),0x070080ff);
assert.deepEqual([0,1,2,3].map(index=>m.fields(window).get(WINDOW_TEXT_OFFSETS.textPlane+4*index)),
  [1,Math.fround(128/255),0,0]);
assert.deepEqual([0,1,2,3].map(index=>m.fields(gc).get(GC_TEXT_OFFSETS.textPlane+4*index)),
  [1,Math.fround(128/255),0,0]);

assert.equal(setTextNative(window,'',services),false);
assert.equal(setTextNative(window,'INCOMING TRANSMISSION...',services),true);
assert.equal(m.fields(window).get(WINDOW_TEXT_OFFSETS.text),'INCOMING TRANSMISSION...');
assert.equal(setTextNative(window,'incoming transmission...',services),false,'appStricmp guard is case-insensitive');
assert.equal(setTextNative(window,'|&Q',services),true);
assert.equal(m.fields(window).get(WINDOW_TEXT_OFFSETS.acceleratorKey),'Q'.charCodeAt(0));
assert.equal(dirty.length,1);assert.equal(reconfigure.length,4);

// XTextWindow::AppendText 0x10045e60 has no unchanged guard: even an empty
// append asks the parent to reconfigure, and an accelerator text re-derives
// its key from the whole text.
appendTextNative(window,'',services);
assert.equal(m.fields(window).get(WINDOW_TEXT_OFFSETS.text),'|&Q');assert.equal(reconfigure.length,5);
appendTextNative(window,' more',services);
assert.equal(m.fields(window).get(WINDOW_TEXT_OFFSETS.text),'|&Q more');assert.equal(reconfigure.length,6);
assert.equal(dirty.length,1,'the unchanged accelerator key does not dirty the table');
const plain={},p=memoryFixture();p.fields(plain).set(WINDOW_TEXT_OFFSETS.text,'');p.fields(plain).set(WINDOW_TEXT_OFFSETS.textFlags,1);
const plainReconfigure=[];
appendTextNative(plain,'Jaime\0tail',{read:p.read,write:p.write,askParentForReconfigure:request=>plainReconfigure.push(request)});
assert.equal(p.fields(plain).get(WINDOW_TEXT_OFFSETS.text),'Jaime','the appended C string stops at its NUL');
assert.equal(plainReconfigure.length,1);
// Window.ConvertScriptString 0x10050710, applied by the SetText/AppendText execs.
assert.equal(convertScriptString('a|nb||nc|x|'),'a\nb||nc|x|');

console.log('Window text passed: installed TextWindow metadata and DLL bodies, native Init defaults, alignment/margin branches, font/GC propagation, packed colors, accelerator scan, SetText guard, AppendText and the exec pipe conversion.');
