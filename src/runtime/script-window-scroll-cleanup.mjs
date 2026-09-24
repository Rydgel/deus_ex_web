/** Owning Scale members, recovered before host admission.
 * Base cleanup/destruction remain the existing Window host services.
 * Evidence: docs/script-window-scroll-cleanup.md. */
const emptyString=(W,object,offset)=>{
 W.farray.empty(object,offset,2);
 // The logical heap also owns a string value at this header address.
 W.heap.write(object,offset,'string','');
};
export function cleanScaleMembers(W,win){
 for(let i=0;i<W.i32(win,0x26c);i++)emptyString(W,W.u32(win,0x268),i*12);
 for(let i=0;i<W.i32(win,0x26c);i++)emptyString(W,W.u32(win,0x268),i*12);
 W.farray.empty(win,0x268,12);
}
export function destroyScaleMembers(W,win){
 const count=W.i32(win,0x26c);
 if(count<0)return W.boundary('Scale label array destructor asserts a nonnegative count');
 if(!count&&W.u32(win,0x268))return W.boundary('Scale destructor retained empty label allocation requires native Free ownership');
 for(let i=0;i<count;i++)emptyString(W,W.u32(win,0x268),i*12);
 // Native Remove followed by FArray destruction leaves no backing allocation.
 // Host farray owns logical storage; native allocation release is still external.
 if(count||W.u32(win,0x268))W.farray.empty(win,0x268,12);
 emptyString(W,win,0x1dc);
}
