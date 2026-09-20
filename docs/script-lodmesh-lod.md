# Original character mesh LOD selection and morphing

## Contract recovered before implementation

Authority: hash-pinned Render.dll, Engine.dll and Core.dll recorded in
[surface/skin selection](script-lodmesh-materials.md). This translates the
LOD portions of DrawLodMesh, not its complete lighting/culling/draw pipeline.

Selection is `10b0eb52..10b0ed53`. Mesh +180 is the ordinary vertex count N;
+184 special vertices are separate. Initialize requested count=N and float
detail=N. Nonzero raw +18c bits and a nonempty +12c point-collapse array enable
LOD. Morphing additionally requires renderer +48 bit 1 and mesh +194 >0.
Original URender.Init (`10b134de..10b134f2`) sets +40=.25, +44=1, +48=1,
+4c=1; these are explicit renderer settings, not arbitrary browser defaults.

Compute f32(appTan(double(f32(viewportActor.FOVAngle +410) *
double .008726646259971648))). Core's actual appTan body `10123260` executes
FPTAN; modes >=3 replace its stored result with 1. The argument's qword store
and the result's f32 store are part of the contract. Hardware measurements must
check these double-input calls because Unicorn's transcendental emulator is
not the hardware authority. Admit finite ordinary FOVs (0<angle<180); extreme
transcendental/invalid allocation domains remain unsupported.

Let complexity=f32(N*f32(.003)+.25), screen=f32(frameWidth*double
.0010937499999999999+double .3). FSceneNode +b8 is the float conversion of
its integer +a8 dimension, as shown by Engine.ComputeRenderSize
`103729a3..103729b8`. Transform Actor.Location (+114) by the caller's FCoords,
with extended origin subtraction and dot intermediates, then store the vector
f32. Depth is its Z minus mesh +198, retained extended, clamped to at least 1.
The retained ratio is:

    mesh[188] * Actor.DrawScale * Actor.LODBias * screen * 430
    / (renderer[44] * renderer[40] * mesh[18c] * depth * complexity * tanFactor)

All factors are float32 fields except named embedded doubles; multiplication
order is exactly the order shown. Actor.LODBias is +64. Mode 0 replaces this
ratio with renderer +4c when nonzero, otherwise 1. Multiply by N, clamp below
to integer mesh +190 (comparison before store), and store f32 detail. Requested
count is min(N, round-nearest-even(detail)); the native FISTP does not truncate.

GetFrame runs next and can reduce the returned count because of its pose cache.
The post-frame LOD range `10b0ee34..10b0ef6e` must use that returned count C.
For candidate morphing, start=round-nearest-even(f32((1-mesh[194])*detail)).
If start>=C, disable morphing. Otherwise hold inverse=1/(detail*mesh[194])
extended and iterate ordinary vertices i=C-1 down to start+1. Alpha is
min((i-start)*inverse,1), retained extended. Read the unsigned word collapse
target from +12c; target zero leaves the position unchanged and stores alpha=0.
Positive targets morph toward the target's **current** position. X retains
delta/product extended; Y/Z store delta and product f32 before the final add.
Write alpha f32 at transformed-vertex +50. Other bytes, special vertices and
positions outside that interval are untouched. If morphing is disabled and
C>=N, disable reduced topology too; otherwise preserve the original LOD flag.

Reduced surface selection is `10b0fc6f..10b0fe60`, skipping to `10b10117`
when face-level word (+138) >C. A face's three wedge words index +15c, as in
the full-resolution path. A zero-initialized u32 scratch table memoizes results
by **original** wedge index. On a cache miss, follow unsigned +150 collapse
links until the wedge's vertex word <C. If morphing is active, vertex>start,
the stored alpha bits are nonzero, and the next wedge differs, interpolate its
U/V bytes toward that next wedge. Skip if both UV bytes already match. Each
interpolation retains arithmetic extended, stores f32, rounds nearest-even to
int, then retains the low byte. Vertex identity stays at the selected wedge's
vertex. Cache the complete packed vertex/U/V dword. Add SpecialVerts only when
addressing the complete GetFrame output. Faces retain original order/materials.

## Reference plan and remaining work

Capture the unchanged selection and post-frame ranges, then the face admission/
wedge-collapse range over verified real mesh arrays. Compare exact float bits,
counts/flags, every output-buffer byte, scratch wedge dwords and selected faces.
Include renderer modes, near/far distances, FOV/width, forced detail, disabled
tables/strength, morph limits and a returned-count reduction. Establish native
references before translating, and retain captures outside Git.

Normal accumulation, backface/clip admission, lighting, texture animation and
locking, draw submission, full NPC startup and world enrollment remain open.
