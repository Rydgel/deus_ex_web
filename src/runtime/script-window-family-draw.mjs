/** Extension.dll Text/Button Draw and button appearance bodies.
 * Native addresses below refer to DLL hash recorded in script-window-host.md. */
import {O,ROOT,getRootWindow} from './script-window-tree-natives.mjs';
import {gcSetAlignments} from './script-gc-set-alignments.mjs';
import {gcEnableWordWrap} from './script-gc-enable-word-wrap.mjs';
import {gcSetTextColor} from './script-gc-set-text-color.mjs';
import {gcSetTileColor} from './script-gc-set-tile-color.mjs';
import {gcDrawPattern} from './script-gc-draw-pattern.mjs';
import {gcDrawText} from './script-gc-draw-text.mjs';
import {f32Bits} from './script-gc-draw-model.mjs';

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
/** 0x10008190 has no work unless both pressed and auto-repeat are set. */
export function buttonTick(W,win){
 if((W.u32(win,0x174)&6)===6)W.boundary('XButtonWindow auto-repeat tick requires mouse-input services');
}
