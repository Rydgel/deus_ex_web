/** Engine thunk10301168/body1030cbb0. See docs/script-lazy-byte-array.md. */
export function loadLazyByteArray(data,{read,write,tell,seek,serializeArray}={}) {
  if(typeof read!=='function')throw new Error('Lazy byte-array Load requires typed reads');
  const call=(service,...args)=>{
    const value=service(...args);
    if(value&&typeof value.then==='function')throw new Error('Lazy byte-array Load services must be synchronous');
    return value;
  };
  const field=key=>call(read,data,key);
  const position=()=>{
    const value=field('lazyField08');
    if(!Number.isInteger(value)||value< -0x80000000||value>0x7fffffff)
      throw new Error('Lazy byte-array position must be a signed int');
    return value;
  };
  if(position()<=0)return;
  if([write,tell,seek,serializeArray].some(service=>typeof service!=='function'))
    throw new Error('Lazy byte-array Load requires archive and field services');
  const saved=call(tell,field('archive'));
  const archive=field('archive'),offset=position();
  call(seek,archive,offset);
  call(serializeArray,field('archive'),field('array'));
  const loadedPosition=position(),restoreArchive=field('archive');
  call(write,data,'lazyField08',(-loadedPosition)|0);
  call(seek,restoreArchive,saved);
}
