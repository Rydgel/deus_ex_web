/** Bounded original Render.dll admission gates; not integrated in Play.
 * Passing these is not visibility: RenderIterator, mesh bounds, BSP chunks
 * and visible spans follow. Evidence and open work: docs/render-visibility.md.
 */
import {x87load,x87add,x87neg,x87mul,x87cmp} from './script-vm.mjs';

const property=(actor,name)=>actor[name];

/** SetupDynamics 0x10b22e1f–0x10b22f42, after the frame-level BSP/SHOW_Actors
 * checks. The return value identifies the next native processing stage.
 * `read` permits live script fields; `isBrush` supplies class ancestry. */
export function dynamicActorRoute(actor,{viewActor,excludedActor=null,read=property,isBrush=()=>false,
  recursion=0,behindView=false,viewTarget=null,highDetailActors=true,editor=false,running=true}={}) {
  if(!actor||read(actor,'bHighDetail')&&!highDetailActors)return 'skip-actor';
  if(recursion===0&&!behindView&&actor===viewTarget)return 'skip-actor';
  if(actor===excludedActor||read(actor,editor?'bHiddenEd':'bHidden'))return 'lights-only';
  let owned=false;
  for(let owner=actor;owner;owner=read(owner,'Owner'))if(owner===viewActor){owned=true;break;}
  if(read(actor,'bOnlyOwnerSee')&&(!owned||behindView))return 'lights-only';
  if(owned&&read(actor,'bOwnerNoSee')&&!behindView)return 'lights-only';
  if(read(actor,'Brush')&&isBrush(actor)&&!read(actor,'bStatic'))return 'moving-brush';
  return running?'render-interface':'lights-only';
}

/** FDynamicSprite::Setup's center-depth comparison, 0x10b239b9–0x10b23a4c.
 * Exact x87 model, assuming the extended precision control word used by the
 * existing mesh translations. A float store happens before comparison, but
 * comparison uses the unrounded value; do not replace this with f32(depth).
 * This standalone reference helper is deliberately not a hot-path shortcut.
 */
export function meshCenterRejected(location,{origin,zAxis,rendMap=5}) {
  if(rendMap===13||rendMap===14||rendMap===15)return false;
  const products=[0,1,2].map(i=>x87mul(
    x87add(x87load(location[i]),x87neg(x87load(origin[i]))),x87load(zAxis[i])));
  const depth=x87add(x87add(products[2],products[1]),products[0]);
  const comparison=x87cmp(depth,x87load(-0));
  return comparison==='lt'||comparison==='un';
}

/** Setup's route before any bounding-box or sprite calculation. */
export function meshSetupRoute(actor,frame) {
  if(actor.DrawType===1||actor.DrawType===7||frame.actorIcons)return 'sprite';
  if(actor.DrawType!==2||!actor.Mesh||meshCenterRejected(actor.Location,frame))return 'rejected';
  return 'mesh-bounds';
}
