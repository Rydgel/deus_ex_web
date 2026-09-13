/** Normal ConSys GetSpeechAudio10010210 path.
 * Original contract: docs/script-conversation-sound-length.md, next boundary.
 * Formatting, loaded-object lookup and native array storage are explicit services.
 */
export function conversationSpeechAudio(conversation,soundID,services={}) {
  const call=(fn,label,...args)=>{
    if(typeof fn!=='function')throw new Error(`GetSpeechAudio requires ${label}`);
    const value=fn(...args);
    if(value&&typeof value.then==='function')throw new Error(`GetSpeechAudio ${label} must be synchronous`);
    return value;
  };
  const read=(object,key)=>call(services.read,'typed reads',object,key);
  const write=(object,key,value)=>call(services.write,'typed writes',object,key,value);
  const object=(value,label)=>{
    if(!value||(typeof value!=='object'&&typeof value!=='function'))
      throw new Error(`GetSpeechAudio requires ${label}`);
    return value;
  };
  const text=(value,label)=>{
    if(typeof value!=='string')throw new Error(`GetSpeechAudio requires ${label} text`);
    return value.split('\0',1)[0];
  };
  const count=array=>{
    const value=read(array,'num');
    if(!Number.isInteger(value)||value<0||value>0x7fffffff)
      throw new Error('GetSpeechAudio reached unsupported native array assertion');
    return value;
  };
  const arrayText=array=>{
    const num=count(array),data=read(array,'data');
    return num===0?'':text(call(services.stringText,'temporary FString text',data,num),'formatted');
  };
  if(!Number.isInteger(soundID)||soundID< -0x80000000||soundID>0x7fffffff)
    throw new Error('GetSpeechAudio requires a signed int soundID');
  if(soundID===-1)return null;
  const outer=object(read(conversation,'Outer'),'Conversation.Outer');
  const name=text(read(outer,'Name'),'Outer.Name');
  if(name.length>=256)throw new Error('GetSpeechAudio Outer name exceeds native stack buffer');
  let prefix=text(call(services.copyString,'appStrcpy',{source:name}),'copied Outer.Name');
  if(prefix!==name)throw new Error('GetSpeechAudio appStrcpy changed Outer.Name');
  if(prefix.length>=4){
    const tail=prefix.slice(-4);
    const equal=call(services.equalText,'appStricmp',tail,'Text');
    if(typeof equal!=='boolean')throw new Error('GetSpeechAudio appStricmp requires a Bool comparison');
    if(equal)prefix=prefix.slice(0,-4);
  }
  const format=(format,args)=>object(call(services.formatString,'FString.Printf',{format,args}),'formatted FString array');
  const objectName=format('ConAudio%s_%d',[text(read(conversation,'audioPackageName'),'audioPackageName'),soundID]);
  const filename=format('..\\System\\%sAudio%s.u',[prefix,text(read(conversation,'audioPackageName'),'audioPackageName')]);
  // Native reads filename Num/Data before object-name Num/Data and class.
  const filenameText=arrayText(filename),objectText=arrayText(objectName);
  const sound=call(services.staticLoadObject,'StaticLoadObject',{
    classRef:object(services.soundClass,'USound class'),outer:null,name:objectText,
    filename:filenameText,flags:2,sandbox:null,
  });
  if(sound!==null)object(sound,'loaded USound result');
  // Both owning FString temporaries are released on the normal return path.
  // Exception unwinding and native assertion recovery remain unsupported.
  const empty=array=>{
    write(array,'num',0);write(array,'max',0);
    call(services.arrayRealloc,'FArray.Realloc',array,2);
    call(services.arrayRemove,'FArray.Remove',array,0,count(array),2);
  };
  empty(filename);
  call(services.arrayDestroy,'FArray destructor',filename);
  empty(objectName);
  const remaining=read(objectName,'data');
  if(remaining!==null&&remaining!==0)call(services.allocatorFree,'FMalloc.Free',remaining);
  return sound;
}
