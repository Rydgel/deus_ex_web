/** GLSL for the sprite tile (docs/frame-projection.md "Sprites"): the chain
 * src/runtime/sprite-tile.mjs is the CPU reference of, with the barrier B() and
 * the correctly rounded divRN of frame-projection-glsl.mjs (they must be in
 * scope), so each x87 operation of the render pass is one binary32 operation.
 *
 *   fpSpriteIcon(a, b)
 *       DrawActorSprite's rectangle (X, Y, XL, YL) handed to UCanvas::DrawIcon
 *   fpCanvasTile(icon, b, c, fxy, rect, src)
 *       UCanvas::DrawTile's clip and scale of a rectangle handed to DrawIcon
 *       (a sprite's, or a light corona's (X, Y, size, size) with Z 1.0:
 *       docs/coronas.md "On the tile chain"); false where DrawTile returns
 *       without drawing
 *   fpSpriteTile(a, b, c, fxy, rect, src)
 *       the two together
 *   fpSpriteVertex(rect, src, a, b, c, frameRect, depth, corner, uv)
 *       D3DDrv's DrawTile: corner 0..3 of the fan (X, Y), (X, Y + YL),
 *       (X + XL, Y + YL), (X + XL, Y) as (X, Y, depth, RHW), with its logical
 *       texture coordinates in `uv`
 *
 * a = (Z, ScreenX, ScreenY, Persp): the sprite's FDynamicSprite in the frame
 * b = (USize, VSize, DrawScale, Scale): the texture and the actor's DrawScale
 * c = (Info.USize, Info.VSize): the locked mip's size (mip 0)
 * fxy = (FX, FY) of the frame; frameRect = (X, Y, XB, YB); depth = (_33, _43)
 */
export const SPRITE_TILE_GLSL = `
vec4 fpSpriteIcon(vec4 a,vec4 b){
  float xl=B(B(b.x*a.w)*b.z),yl=B(B(b.y*a.w)*b.z);
  return vec4(B(a.y-B(xl*0.5)),B(a.z-B(yl*0.5)),xl,yl);}
bool fpCanvasTile(vec4 icon,vec4 b,vec4 c,vec2 fxy,out vec4 rect,out vec4 src){
  rect=vec4(0.0);src=vec4(0.0);
  float x=icon.x,y=icon.y,xl=icon.z,yl=icon.w;
  float u=0.0,v=0.0,ul=b.x,vl=b.y;
  if(!(xl>0.0)||!(yl>0.0))return false;
  float x2=B(x+xl),y2=B(y+yl);
  if(!(x2>0.0)||!(y2>0.0))return false;
  if(!(x<fxy.x)||!(y<fxy.y))return false;
  if(x<0.0){float t=divRN(B(x*ul),xl);x=0.0;xl=x2;u=B(u-t);ul=B(t+ul);}
  if(y<0.0){float t=divRN(B(y*vl),yl);y=0.0;yl=y2;v=B(v-t);vl=B(t+vl);}
  float dx=B(fxy.x-x);
  if(xl>dx){ul=B(divRN(B(B(dx-xl)*ul),xl)+ul);xl=dx;}
  float dy=B(fxy.y-y);
  if(yl>dy){vl=B(divRN(B(B(dy-yl)*vl),yl)+vl);yl=dy;}
  float fu=divRN(B(c.x*b.w),b.x),fv=divRN(B(c.y*b.w),b.y);
  src=vec4(B(u*fu),B(v*fv),B(ul*fu),B(vl*fv));
  rect=vec4(x,y,xl,yl);
  return true;}
bool fpSpriteTile(vec4 a,vec4 b,vec4 c,vec2 fxy,out vec4 rect,out vec4 src){
  return fpCanvasTile(fpSpriteIcon(a,b),b,c,fxy,rect,src);}
vec4 fpSpriteVertex(vec4 rect,vec4 src,vec4 a,vec4 b,vec4 c,vec4 frameRect,vec2 depth,int corner,out vec2 uv){
  float rhw=divRN(1.0,a.x);
  float sz=B(B(rhw*depth.y)+depth.x);
  float x0=B(B(frameRect.z-0.5)+rect.x),y0=B(B(frameRect.w-0.5)+rect.y);
  float x1=B(x0+rect.z),y1=B(y0+rect.w);
  float um=divRN(1.0,B(c.x*b.w)),vm=divRN(1.0,B(c.y*b.w));
  float u0=B(src.x*um),v0=B(src.y*vm),u1=B(B(src.x+src.z)*um),v1=B(B(src.y+src.w)*vm);
  bool right=corner>=2,bottom=corner==1||corner==2;
  uv=vec2(right?u1:u0,bottom?v1:v0);
  return vec4(right?x1:x0,bottom?y1:y0,sz,rhw);}
`;
