/** Original bitmap pages + recovered native GC.DrawText scan/clip/glyph path.
 * The heap and texture Lock/DrawTile services here are presentation-owned.
 */
import {readObject} from '../unreal/objects.mjs';
import {TextureStore} from '../unreal/textures.mjs';
import {decodeFontExport,writeFontImage,UFONT,FONT_PAGE} from '../runtime/script-font-model.mjs';
import {GC} from '../runtime/script-gc-state-model.mjs';
import {gcDrawText} from '../runtime/script-gc-draw-text.mjs';
import {gcSetTextColor} from '../runtime/script-gc-set-text-color.mjs';
import {f32Bits,bitsToF32} from '../runtime/script-gc-draw-model.mjs';

export async function createHudText(assets,names){
  const bytes=new Uint8Array(1024*1024),view=new DataView(bytes.buffer);let next=16;
  const types={u8:['getUint8','setUint8'],u16:['getUint16','setUint16'],u32:['getUint32','setUint32'],
    i32:['getInt32','setInt32'],f32:['getFloat32','setFloat32']};
  const mem={bytes,
    allocRaw(size){const at=next;next+=(size+15)&~15;if(next>bytes.length)throw new Error('HUD text storage exhausted');return at;},
    read(at,kind){return view[types[kind][0]](at,true);},
    write(at,kind,value){view[types[kind][1]](at,value,true);},
  };
  const put=(at,offset,value,kind='u32')=>mem.write(at+offset,kind,value);
  const gc={base:mem.allocRaw(GC.size)},canvas=mem.allocRaw(0x80),viewport=mem.allocRaw(0xc0),
    node=mem.allocRaw(0x40),ri=mem.allocRaw(4),riTable=mem.allocRaw(0x100);
  put(canvas,0x78,viewport);put(canvas,0x7c,node);put(node,0,viewport);put(viewport,0x64,ri);
  put(ri,0,riTable);put(riTable,0x7c,3);put(gc.base,GC.canvas,canvas);
  put(gc.base,GC.flags,2);put(gc.base,GC.textPolyFlags,0x802);put(gc.base,GC.textFlags,1);
  put(gc.base,0x9c,1);put(gc.base,0xa0,1);put(gc.base,GC.depth,1);
  const texCache={records:Array.from({length:5},()=>mem.allocRaw(0x84)),static:mem.allocRaw(0x84),head:0,count:0};
  const fonts=new Map(),images=new Map(),texturePointers=new Map(),textures=new TextureStore(assets);
  for(const name of names){
    const [pkg,...path]=name.split('.'),asset=await assets.get(pkg),index=asset.exportsByPath.get(path.join('.').toLowerCase());
    if(!index)throw new Error(`Original font missing: ${name}`);
    const e=asset.pkg.exports[index-1];
    const decoded=decodeFontExport(asset.bytes.subarray(e.serialOffset,e.serialOffset+e.serialSize),name);
    const r=readObject(asset.pkg,asset.bytes,index).reader;
    if(r.compact()!==decoded.pageCount)throw new Error('Original font page count mismatch');
    const font=writeFontImage(mem,decoded),table=mem.read(font+UFONT.pages,'u32');
    for(let p=0;p<decoded.pageCount;p++){
      // Engine UFont::Serialize -> FFontPage 10385940: UObject* ref first,
      // then the compact glyph count and 16-byte FFontCharacter records.
      const ref=r.compact(),count=r.compact();
      if(count!==decoded.pages[p].chars.length)throw new Error('Original font glyph count mismatch');
      r.take(count*16);
      const data=await textures.get(asset,ref,true),image={key:data.key,...data.mips[0]};images.set(data.key,image);
      let pointer=texturePointers.get(data.key);
      if(!pointer){pointer=mem.allocRaw(0x60);const vt=mem.allocRaw(0x80);put(pointer,0,vt);put(vt,0x54,1);put(vt,0x58,2);
        put(pointer,0x34,image.width,'i32');put(pointer,0x38,image.height,'i32');texturePointers.set(data.key,pointer);}
      put(table+p*FONT_PAGE.size,0,pointer);
    }
    if(r.i32()!==decoded.charsPerPage||r.offset!==r.bytes.length)throw new Error('Trailing original font data');
    fonts.set(name.toLowerCase(),font);
  }
  const byPointer=new Map([...texturePointers].map(([key,pointer])=>[pointer,images.get(key)]));
  let emit;
  const services={mem,texCache,allocateObject:()=>mem.allocRaw(GC.size),constructUObject:()=>{},
    callVirtual(slot,object,command){
      if(slot===1){put(command.record,0,object);return;}
      if(slot===2)return;
      if(slot!==3)throw new Error('Unsupported HUD text render operation');
      emit({image:byPointer.get(mem.read(command.record,'u32')),x:bitsToF32(command.x),y:bitsToF32(command.y),
        width:bitsToF32(command.xl),height:bitsToF32(command.yl),u:bitsToF32(command.u),v:bitsToF32(command.v),
        color:command.color.slice(0,3).map(bits=>bitsToF32(bits)*255),style:command.polyFlags&4?3:2});
    },
  };
  return {images,fonts,
    draw(draw,{font,text,x,y,width,height,color=[255,255,255],hAlign=0,vAlign=0,wrap=true}){
      const pointer=fonts.get(font.toLowerCase());if(!pointer)throw new Error(`HUD font not prepared: ${font}`);
      put(gc.base,GC.normalFont,pointer);put(gc.base,GC.boldFont,pointer);
      put(gc.base,GC.clipX,x,'f32');put(gc.base,GC.clipY,y,'f32');put(gc.base,GC.clipWidth,width,'f32');put(gc.base,GC.clipHeight,height,'f32');
      put(gc.base,GC.hAlign,hAlign,'u8');put(gc.base,GC.vAlign,vAlign,'u8');put(gc.base,GC.textFlags,wrap?1:0);
      gcSetTextColor(gc,(color[0]|color[1]<<8|color[2]<<16)>>>0,services);emit=draw;
      gcDrawText(gc,...[x,y,width,height].map(f32Bits),text,services);
    },
  };
}
