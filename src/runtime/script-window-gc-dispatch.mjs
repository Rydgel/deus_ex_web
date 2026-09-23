/** Script GC argument marshalling into the recovered native implementations. */
import {refValue} from './script-vm.mjs';
import {f32Bits} from './script-gc-draw-model.mjs';
import {gcIntersect} from './script-gc-intersect.mjs';
import {gcEnableSmoothing} from './script-gc-enable-smoothing.mjs';
import {gcIsSmoothingEnabled} from './script-gc-is-smoothing-enabled.mjs';
import {gcSetStyle} from './script-gc-set-style.mjs';
import {gcGetStyle} from './script-gc-get-style.mjs';
import {gcEnableDrawing} from './script-gc-enable-drawing.mjs';
import {gcIsDrawingEnabled} from './script-gc-is-drawing-enabled.mjs';
import {gcEnableMasking} from './script-gc-enable-masking.mjs';
import {gcIsMaskingEnabled} from './script-gc-is-masking-enabled.mjs';
import {gcEnableTranslucency} from './script-gc-enable-translucency.mjs';
import {gcIsTranslucencyEnabled} from './script-gc-is-translucency-enabled.mjs';
import {gcEnableModulation} from './script-gc-enable-modulation.mjs';
import {gcIsModulationEnabled} from './script-gc-is-modulation-enabled.mjs';
import {gcSetTileColor} from './script-gc-set-tile-color.mjs';
import {gcGetTileColor} from './script-gc-get-tile-color.mjs';
import {gcSetTextColor} from './script-gc-set-text-color.mjs';
import {gcGetTextColor} from './script-gc-get-text-color.mjs';
import {gcSetFont} from './script-gc-set-font.mjs';
import {gcSetNormalFont} from './script-gc-set-normal-font.mjs';
import {gcSetBoldFont} from './script-gc-set-bold-font.mjs';
import {gcSetFonts} from './script-gc-set-fonts.mjs';
import {gcGetFonts} from './script-gc-get-fonts.mjs';
import {gcEnableTranslucentText} from './script-gc-enable-translucent-text.mjs';
import {gcIsTranslucentTextEnabled} from './script-gc-is-translucent-text-enabled.mjs';
import {gcSetTextVSpacing} from './script-gc-set-text-v-spacing.mjs';
import {gcGetTextVSpacing} from './script-gc-get-text-v-spacing.mjs';
import {gcSetHorizontalAlignment} from './script-gc-set-horizontal-alignment.mjs';
import {gcGetHorizontalAlignment} from './script-gc-get-horizontal-alignment.mjs';
import {gcSetVerticalAlignment} from './script-gc-set-vertical-alignment.mjs';
import {gcGetVerticalAlignment} from './script-gc-get-vertical-alignment.mjs';
import {gcSetAlignments} from './script-gc-set-alignments.mjs';
import {gcGetAlignments} from './script-gc-get-alignments.mjs';
import {gcEnableWordWrap} from './script-gc-enable-word-wrap.mjs';
import {gcIsWordWrapEnabled} from './script-gc-is-word-wrap-enabled.mjs';
import {gcEnableSpecialText} from './script-gc-enable-special-text.mjs';
import {gcIsSpecialTextEnabled} from './script-gc-is-special-text-enabled.mjs';
import {gcSetBaselineData} from './script-gc-set-baseline-data.mjs';
import {gcCopyGC} from './script-gc-copy-gc.mjs';
import {gcPushGC} from './script-gc-push-gc.mjs';
import {gcPopGC} from './script-gc-pop-gc.mjs';
import {gcGetTextExtent} from './script-gc-get-text-extent.mjs';
import {gcGetFontHeight} from './script-gc-get-font-height.mjs';
import {gcDrawText} from './script-gc-draw-text.mjs';
import {gcDrawIcon} from './script-gc-draw-icon.mjs';
import {gcDrawTexture} from './script-gc-draw-texture.mjs';
import {gcDrawPattern} from './script-gc-draw-pattern.mjs';
import {gcDrawBox} from './script-gc-draw-box.mjs';
import {gcDrawStretchedTexture} from './script-gc-draw-stretched-texture.mjs';
import {gcDrawBorders} from './script-gc-draw-borders.mjs';
const natives = new Map([[1200,gcIntersect],
[1210,gcEnableSmoothing],
[1211,gcIsSmoothingEnabled],
[1212,gcSetStyle],
[1213,gcGetStyle],
[1214,gcEnableDrawing],
[1215,gcIsDrawingEnabled],
[1216,gcEnableMasking],
[1217,gcIsMaskingEnabled],
[1218,gcEnableTranslucency],
[1219,gcIsTranslucencyEnabled],
[1220,gcEnableModulation],
[1221,gcIsModulationEnabled],
[1230,gcSetTileColor],
[1231,gcGetTileColor],
[1240,gcSetTextColor],
[1241,gcGetTextColor],
[1242,gcSetFont],
[1243,gcSetNormalFont],
[1244,gcSetBoldFont],
[1245,gcSetFonts],
[1246,gcGetFonts],
[1247,gcEnableTranslucentText],
[1248,gcIsTranslucentTextEnabled],
[1250,gcSetTextVSpacing],
[1251,gcGetTextVSpacing],
[1252,gcSetHorizontalAlignment],
[1253,gcGetHorizontalAlignment],
[1254,gcSetVerticalAlignment],
[1255,gcGetVerticalAlignment],
[1256,gcSetAlignments],
[1257,gcGetAlignments],
[1258,gcEnableWordWrap],
[1259,gcIsWordWrapEnabled],
[1260,gcEnableSpecialText],
[1261,gcIsSpecialTextEnabled],
[1262,gcSetBaselineData],
[1270,gcCopyGC],
[1271,gcPushGC],
[1272,gcPopGC],
[1280,gcGetTextExtent],
[1281,gcGetFontHeight],
[1282,gcDrawText],
[1283,gcDrawIcon],
[1284,gcDrawTexture],
[1285,gcDrawPattern],
[1286,gcDrawBox],
[1287,gcDrawStretchedTexture],
[1289,gcDrawBorders]]);
const pack = c=>['r','g','b','a'].reduce((n,k,i)=>n|((c?.[`core.object.color.${k}`]??0)&255)<<(8*i),0)>>>0;
const unpack = n=>Object.fromEntries(['r','g','b','a'].map((k,i)=>[`core.object.color.${k}`,(n>>>(8*i))&255]));
export function dispatchGcNative(heap,services,call) {
 const fn=natives.get(call.index);if(!fn)return {handled:false};
 const raw=Array.from({length:call.argumentCount},(_,i)=>call.evaluateArgument(i));
 const a=raw.map(refValue),set=(i,v)=>{if(raw[i]?.reference)raw[i].set(v);};
 let value;
 switch(call.index){
  case 1230:case 1240:a[0]=pack(a[0]);break;
  case 1242:case 1243:case 1244:case 1270:a[0]=heap.addressOf(a[0]);break;
  case 1245:a[0]=heap.addressOf(a[0]);a[1]=heap.addressOf(a[1]);break;
  case 1272:a[0]??=-1;break;
  case 1281:a[0]??=false;break;
  case 1262:a[0]??=0;a[1]??=0;break;
 }
 if(call.index===1280){value=fn(call.receiver,a[0],a[3],services);set(1,value.width);set(2,value.height);value=undefined;}
 else if(call.index===1231||call.index===1241){set(0,unpack(fn(call.receiver,services)));}
 else if(call.index===1246){const r=fn(call.receiver,services);set(0,heap.objectAt(r.normalFont));set(1,heap.objectAt(r.boldFont));}
 else if(call.index===1257){const r=fn(call.receiver,services);set(0,r.hAlign);set(1,r.vAlign);}
 else {
  if(call.index>=1282&&call.index<=1287){
   const count=call.index===1283?2:call.index===1282?4:call.index===1287?8:call.index===1286?7:6;
   for(let i=0;i<count;i++)a[i]=f32Bits(a[i]);
   if(call.index!==1282)a[count]=heap.addressOf(a[count]);
  }
  if(call.index===1289){for(let i=0;i<8;i++)a[i]=f32Bits(a[i]);a[8]=a[8].map(r=>heap.addressOf(r));a[9]??=false;a[10]??=false;}
  value=fn(call.receiver,...a,services);
 }
 return {handled:true,value};
}
