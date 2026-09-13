/** Engine USound constructor1034cdc0; storage is already allocated and its
 * header/template fields initialized by the caller. */
export function constructSoundNative(sound,{arrayRealloc}={}) {
  if(!sound||typeof sound!=='object')throw new TypeError('USound requires allocated object storage');
  if(typeof arrayRealloc!=='function')throw new Error('USound constructor requires FArray::Realloc');
  sound.nativeVtable=0x10179dfc;
  const data=sound.soundData??(sound.soundData={});
  const array=data.array??(data.array={});
  array.data=null;array.num=0;array.max=0;
  arrayRealloc(array,1);
  data.archive=null;
  data.lazyField08=0;
  data.owner=sound;
  data.nativeVtable=0x1042999c;
  sound.nativeVtable=0x10429580;
  sound.durationCache=-1;
  return sound;
}
