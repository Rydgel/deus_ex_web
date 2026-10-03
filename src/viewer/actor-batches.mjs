/** Draw batching for GPU-path actor mesh groups (docs/gpu-mesh.md, "Draw
 * batches"). With positions and colours fetched from the GPU mesh textures,
 * groups of different actors that share one material state can be drawn by
 * one three.js mesh. Only opaque and masked groups are batched: their draw
 * order does not change the image (depth test, alpha test). Translucent and
 * modulated groups stay separate meshes, sorted as before.
 *
 * Visibility stays the per-group, per-pass decision the actor layer makes;
 * a batch member hidden in a pass collapses its triangles outside the clip
 * volume. Render feedback is unchanged: after a batch is drawn, every member
 * visible in that pass stamps its actor, exactly the groups whose own meshes
 * three.js would have drawn and whose onAfterRender would have run. */
import * as THREE from 'three';

export const BATCH_VERTEX_DECLARATIONS=`
attribute float deusMember;uniform highp sampler2D deusMembers;
`;
// After project_vertex: a hidden member's vertices all land on one point
// beyond the far plane, so its triangles produce no fragments.
export const BATCH_VERTEX_TAIL=`
if (texelFetch(deusMembers, ivec2(int(deusMember) & 1023, int(deusMember) >> 10), 0).r < 0.5)
  gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
`;

export function createActorBatches(root,{makeMaterial}) {
  const batches=new Map();
  const dirty=new Set();
  let stamping=true;

  function batchFor(key,template) {
    let batch=batches.get(key);
    if(batch)return batch;
    const members=[];
    const data=new Uint8Array(4*1024);
    const texture=new THREE.DataTexture(data,1024,1,THREE.RGBAFormat,THREE.UnsignedByteType);
    texture.minFilter=texture.magFilter=THREE.NearestFilter;texture.generateMipmaps=false;texture.flipY=false;
    texture.needsUpdate=true;
    const material=makeMaterial(template,{value:texture});
    const mesh=new THREE.Mesh(new THREE.BufferGeometry(),material);
    mesh.frustumCulled=false;mesh.visible=false;mesh.name=`actor batch ${key}`;mesh.matrixAutoUpdate=false;
    mesh.userData.actorBatch=true;
    batch={key,members,data,texture,material,mesh,rows:1};
    mesh.onAfterRender=renderer=>{
      if(!stamping)return;
      for(const member of members)if(member.visible)member.rendered(renderer);
    };
    root.add(mesh);batches.set(key,batch);
    return batch;
  }
  function rebuild(batch) {
    const {members}=batch;
    const corners=members.reduce((total,member)=>total+member.group.indices.length,0);
    const rows=Math.max(1,Math.ceil(members.length/1024));
    if(rows!==batch.rows){
      batch.texture.dispose();
      batch.data=new Uint8Array(4*1024*rows);
      batch.texture=new THREE.DataTexture(batch.data,1024,rows,THREE.RGBAFormat,THREE.UnsignedByteType);
      batch.texture.minFilter=batch.texture.magFilter=THREE.NearestFilter;batch.texture.generateMipmaps=false;
      batch.texture.flipY=false;batch.rows=rows;batch.material.userData.members.value=batch.texture;
    }
    const geometry=new THREE.BufferGeometry();
    const position=new Float32Array(corners*3),uv=new Float32Array(corners*2);
    const vertexTexel=new Float32Array(corners),cornerTexel=new Float32Array(corners),member=new Float32Array(corners);
    let at=0;
    members.forEach((entry,index)=>{
      entry.index=index;
      const source=entry.group.geometry.attributes,n=entry.group.indices.length;
      uv.set(source.uv.array.subarray(0,n*2),at*2);
      vertexTexel.set(source.deusVertexTexel.array.subarray(0,n),at);
      cornerTexel.set(source.deusCornerTexel.array.subarray(0,n),at);
      member.fill(index,at,at+n);at+=n;
    });
    geometry.setAttribute('position',new THREE.BufferAttribute(position,3));
    geometry.setAttribute('uv',new THREE.BufferAttribute(uv,2));
    geometry.setAttribute('deusVertexTexel',new THREE.BufferAttribute(vertexTexel,1));
    geometry.setAttribute('deusCornerTexel',new THREE.BufferAttribute(cornerTexel,1));
    geometry.setAttribute('deusMember',new THREE.BufferAttribute(member,1));
    // Sorting key only (opaque order): the batch draws nothing by itself.
    geometry.boundingSphere=new THREE.Sphere(new THREE.Vector3(),Infinity);
    batch.mesh.geometry.dispose();batch.mesh.geometry=geometry;
  }
  return {
    /** Put a group in the batch for `key`; `template` is its material. */
    add(key,template,entry){
      const batch=batchFor(key,template);
      entry.batch=batch;entry.visible=false;batch.members.push(entry);dirty.add(batch);
    },
    remove(entry){
      const batch=entry.batch;if(!batch)return;
      const at=batch.members.indexOf(entry);if(at>=0)batch.members.splice(at,1);
      entry.batch=null;dirty.add(batch);
    },
    /** A member's decision for the coming pass. */
    set(entry,visible){
      entry.visible=visible;
      const batch=entry.batch,i=entry.index;
      if(batch&&i!==undefined&&i>=0){const byte=visible?255:0;
        if(batch.data[i*4]!==byte){batch.data[i*4]=byte;batch.changed=true;}}
    },
    /** Before a pass: rebuild changed batches, upload member flags. */
    flush(){
      for(const batch of dirty){
        if(!batch.members.length){batch.mesh.removeFromParent();batch.mesh.geometry.dispose();batch.material.dispose();
          batch.texture.dispose();batches.delete(batch.key);continue;}
        rebuild(batch);batch.changed=true;
        for(const member of batch.members)batch.data[member.index*4]=member.visible?255:0;
      }
      dirty.clear();
      for(const batch of batches.values()){
        if(batch.changed){batch.texture.needsUpdate=true;batch.changed=false;}
        batch.mesh.visible=batch.members.some(member=>member.visible);
      }
    },
    stats(){return {batches:batches.size,members:[...batches.values()].reduce((n,b)=>n+b.members.length,0)};},
    dispose(){for(const batch of batches.values()){batch.mesh.removeFromParent();batch.mesh.geometry.dispose();
      batch.material.dispose();batch.texture.dispose();}batches.clear();},
  };
}
