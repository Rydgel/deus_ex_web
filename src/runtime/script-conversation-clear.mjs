/** ConSys ClearBindEvents10010200 walks links without clearing event fields. */
export function clearConversationEvents(conversation,{read}={}) {
  if(typeof read!=='function')throw new Error('ClearBindEvents requires canonical event reads');
  const seen=new Set();
  for(let event=read(conversation,'eventList');event!==null;event=read(event,'nextEvent')){
    if(event===undefined)throw new Error('ClearBindEvents reached an unresolved event reference');
    if(seen.has(event))throw new Error('Cyclic ClearBindEvents chain');
    seen.add(event);
  }
}
