/** Original Extension XWindow::ProcessScript1004ded0 and the ordinary Core
 * FindFunction/FindFunctionChecked gates. See docs/script-window-script.md.
 * Linked lookup supplies canonical UFunctions; Core diagnostics stay unbound. */
export function processWindowScript({object,event,parameters=null,thirdArgument=1}, services={}) {
  const call=(name,args)=>{
    if(typeof services[name]!=='function')throw new Error(`Window.ProcessScript requires ${name}`);
    const value=services[name](args);
    if(value&&typeof value.then==='function')throw new Error(`Window.ProcessScript ${name} suspended`);
    return value;
  };
  if(!object||typeof event!=='string'||!event||event.includes('\0')||!Number.isInteger(thirdArgument))
    throw new Error('Window.ProcessScript requires a canonical receiver, resolved FName and integer lookup selector');
  if(thirdArgument!==0){
    const scriptable=call('isScriptable');
    if(typeof scriptable!=='boolean')throw new Error('Window.ProcessScript requires explicit GIsScriptable');
    if(!scriptable)return;
  }
  const record=call('findFunction',{object,event,global:false});
  if(record===null){
    if(thirdArgument!==0)throw new Error(`Window.ProcessScript checked missing-function diagnostic is unbound: ${event}`);
    return;
  }
  if(!record||typeof record!=='object')throw new Error('Window.ProcessScript lookup did not resolve a UFunction');
  call('processEvent',{object,record,parameters,result:null,virtualSlot:0x10});
}
