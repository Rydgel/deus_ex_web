/** Extension.dll Text/Button Draw and button appearance bodies.
 * Native addresses below refer to DLL hash recorded in script-window-host.md. */
import {O,ROOT,getRootWindow} from './script-window-tree-natives.mjs';
import {gcSetAlignments} from './script-gc-set-alignments.mjs';
import {gcEnableWordWrap} from './script-gc-enable-word-wrap.mjs';
import {gcSetTextColor} from './script-gc-set-text-color.mjs';
import {gcSetTileColor} from './script-gc-set-tile-color.mjs';
import {gcDrawPattern} from './script-gc-draw-pattern.mjs';
import {gcDrawText} from './script-gc-draw-text.mjs';
import {f32Bits,gcTileEmitGate} from './script-gc-draw-model.mjs';
import {gcMemory} from './script-gc-state-model.mjs';
import {gcSetStyle} from './script-gc-set-style.mjs';
import {checkboxSize} from './script-window-family-layout.mjs';
import {x87load as X,x87int32 as I,x87add as A,x87neg as N,x87mul as M,x87store as S,x87ftol as T} from './script-vm.mjs';

/** XTextWindow::Draw 0x10046930. Script DrawWindow runs before native text. */
export function textDraw(W,win,gc){
 const s=W.gc.services;
 gcSetAlignments(gc,W.u8(win,0x14c),W.u8(win,0x14d),s);
 gcEnableWordWrap(gc,W.u32(win,0x150)&1,s);
 W.processScript(win,'DrawWindow',[gc]);
 const x=W.f32(win,0x154),y=W.f32(win,0x158);
 gcDrawText(gc,...[x,y,W.f32(win,O.width)-2*x,W.f32(win,O.height)-2*y].map(f32Bits),W.heap.read(win,0x168,'string'),s);
}
/** XButtonWindow::Draw 0x100082c0. */
export function buttonDraw(W,win,gc){
 const s=W.gc.services;
 gcSetTileColor(gc,W.u32(win,0x188),s);gcSetTextColor(gc,W.u32(win,0x18c),s);
 gcDrawPattern(gc,...[0,0,W.f32(win,O.width),W.f32(win,O.height),0,0].map(f32Bits),W.u32(win,0x184),s);
 textDraw(W,win,gc);
}
/** The GC bodies XCheckboxWindow::Draw calls; a check may record them instead. */
export const CHECKBOX_DRAW_GC=Object.freeze({
 setAlignments:gcSetAlignments,enableWordWrap:gcEnableWordWrap,setTextColor:gcSetTextColor,drawText:gcDrawText,
 setStyle:gcSetStyle,setTileColor:gcSetTileColor,
 tile:(gc,command,s)=>gcTileEmitGate(gcMemory(gc,s),command),
});
/** XCheckboxWindow::Draw 0x1000aad0. After the GC alignment/wrap state and the
 * script DrawWindow (XWindow::Draw 0x10003bf0), the pressed bit (+0x174 & 1)
 * picks toggleOn or toggleOff and the checkbox extent (0x1000a9c0) is read.
 * The box top is _ftol((height - boxHeight) * 0.5) as a float; the text box is
 * width - (2*hMargin + extent) by height - 2*vMargin at y = vMargin + 1.0f,
 * after the box (bRightSide +0x208 bit 0: box at width - (extent + hMargin),
 * text at hMargin) or before it. A texture is drawn through the tile gate
 * 0x10028770 with checkboxStyle (+0x20c) and checkboxColor (+0x20d). */
export function checkboxDraw(W,win,gc,ops=CHECKBOX_DRAW_GC){
 const s=W.gc.services,hm=W.f32(win,0x154),vm=W.f32(win,0x158);
 ops.setAlignments(gc,W.u8(win,0x14c),W.u8(win,0x14d),s);
 ops.enableWordWrap(gc,W.u32(win,0x150)&1,s);
 W.processScript(win,'DrawWindow',[gc]);
 const texture=W.u32(win,0x174)&1?W.ptr(win,0x1f8):W.ptr(win,0x1f4);
 const box=checkboxSize(W,win),width=W.f32(win,O.width),height=W.f32(win,O.height);
 const top=S(I(T(M(A(X(height),N(X(box.height))),X(0.5)))));
 const textWidth=S(A(X(width),N(A(A(X(hm),X(hm)),X(box.extra)))));
 const textHeight=S(A(X(height),N(A(X(vm),X(vm)))));
 const right=W.u8(win,0x208)&1;
 const textX=right?W.u32(win,0x154):f32Bits(S(A(X(box.extra),X(hm))));
 const boxX=right?S(A(X(width),N(A(X(box.extra),X(hm))))):hm;
 ops.setTextColor(gc,W.u32(win,0x18c),s);
 ops.drawText(gc,textX,f32Bits(S(A(X(vm),X(1)))),f32Bits(textWidth),f32Bits(textHeight),W.heap.read(win,0x168,'string'),s);
 if(!texture)return;
 ops.setStyle(gc,W.u8(win,0x20c),s);
 ops.setTileColor(gc,W.u32(win,0x20d),s);
 ops.tile(gc,{texture:W.addressOf(texture),x:boxX,y:top,w:box.width,h:box.height,u:0,v:0,ul:box.width,vl:box.height},s);
}
/** XButtonWindow::ChangeButtonAppearance 0x10008380. */
export function changeButtonAppearance(W,win){
 let ancestor=win;while(ancestor&&(W.u8(ancestor,O.flags)&2))ancestor=W.ptr(ancestor,O.parent);
 const root=getRootWindow(W,win),focused=root&&W.ptr(root,ROOT.focus)===win;
 const state=ancestor?2:(focused?1:0),toggle=W.u32(win,0x174)&1,index=state*2+toggle;
 const at=0x1a4+12*index;
 let texture=W.ptr(win,at);const tile=W.u32(win,at+4),text=W.u32(win,at+8);
 if(!texture){if(toggle)texture=W.ptr(win,0x1b0);if(!texture)texture=W.ptr(win,0x1a4);}
 W.setU32(win,0x18c,text);W.setPtr(win,0x184,texture);W.setU32(win,0x188,tile);
}
/* XButtonWindow::Tick 0x10008190 (the auto-repeat) is script-window-input.mjs buttonTick: it needs the pointer. */
