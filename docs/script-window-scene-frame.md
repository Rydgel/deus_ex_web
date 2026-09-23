# Original scene-frame fields used by HUD world projection

The source contract is Engine.dll SHA256
`0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4`
and Core.dll SHA256
`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`.
This slice produces the fields consumed by Extension RootWindow's
`ConvertVectorToCoordinates`; it does not claim to build the full renderer frame.

`FSceneNode::ComputeRenderCoords`, thunk `0x103019d3`, body `0x10372580`,
requires a viewport with a nonnull Actor (`viewport+0x30`). Normal perspective
modes (Actor+0x600 other than 13/14/15) copy `GMath.ViewCoords` from
`GMath+0x5c`, execute Core `FCoords::operator/=(FRotator)` (thunk `0x1010314d`,
body `0x1011b690`), then add the passed camera location to the stored Origin,
one float32 store per component. The resulting 12 floats copy to frame+0x34.
ViewCoords is `(0,0,0), (0,1,0), (0,0,-1), (1,0,0)`, captured after the actual
GMath constructor. The Core rotation operation is the existing documented
roll/pitch/yaw transform from `script-pawn-locomotion.md`, applied to these
initial fields rather than UnitCoords. Each axis dot stores float32 after
`(x*xaxis + y*yaxis) + z*zaxis`; origin subtraction remains extended.
Orthographic modes 13/14/15 select other fixed bases and remain unsupported.

The native then stores transposed coordinates at frame+0x64 and calls
`ComputeRenderSize` (thunk `0x10302d6f`, body `0x10372980`). The fields needed
for HUD projection are:

- `frame+0xa8/+0xac`: signed integer physical width/height supplied by caller.
- `frame+0xb8/+0xbc`: the float32 conversion of those integers.
- `frame+0xc8`: float32 of the retained integer width times double 0.5.
- `frame+0xcc`: float32 of the stored float32 height times double 0.5.
- `frame+0xdc` (Proj.Z): float32 of `(float32(width) * double 0.5) / tangent`.

`tangent` is the result of `Core.appTan`, thunk `0x101025c2`, body `0x10123260`
(`fld qword; fptan; fstp st(0); ret`), stored to a double immediately after
return. The argument is a double store of `float32(viewport.Actor.FOVAngle)
* double 0.008726646259971648` (Engine constant `0x1042b908`). The tangent
boundary requires hardware evidence: Unicorn's FPTAN implementation is not the
original x87 authority. Use the existing `tools/x87-transcendental-probe.c`
`--double-tan` lane under CrossOver/Rosetta, round its captured extended result
to double, and inject that measured leaf into the unchanged Engine oracle.

The reference plan is focused: execute original ComputeRenderCoords and the
complete ComputeRenderSize, retaining the measured tangent boundary and a
recorded no-op render-device callback. Compare every consumed float32 bit,
including signed zero, over ordinary and wrapped rotations, nonzero camera
origins, physical viewport sizes and the admitted FOV values. Camera location,
rotation and FOV are explicit host inputs; camera production and player view
selection are not replaced by a browser-camera approximation in this module.

## Implemented boundary and host contract

`buildWindowSceneFrame({location, rotation, width, height, fov, renderMode})`
accepts the original camera location as three float components, camera rotation
as `[pitch,yaw,roll]` int32, positive int32 physical viewport dimensions and
Actor.FOVAngle. Render mode defaults to normal perspective mode 5. It returns
flat `coords` (12 float32s), float32 `width`/`height`, two-element `center` and
`projectionZ`. `writeWindowSceneFrame(W, frame, input)` writes precisely the
fields listed above through `W.setI32`/`W.setF32` and returns that value. The HUD
host separately assigns RootWindow+0x740 to this allocated frame. Root integer
UI multipliers remain in the projection consumer and must not be folded into
the physical input dimensions.

The default tangent leaf admits the measured FOV values 1, 30, 60, 75, 90, 120,
and 170 degrees. Other float32 FOV values require an explicit
`appTan(doubleArgument)` service returning the original qword result, or throw
an unsupported-boundary error. There is no `Math.tan` fallback. Orthographic
modes 13/14/15 remain unsupported. Transpose, frustum, device setup and the rest
of FSceneNode are outside this HUD-consumed field slice. The caller must supply
the original selected view location/rotation, including any original eye-height
or camera effects; those producers are not established by this translation.

## Validation

`node scripts/validate-window-scene-frame.mjs` builds the existing exact Core
appTan instruction probe into a dedicated ignored cache path, runs eight
double inputs through CrossOver/Rosetta with x87 control word 0x037f, then
executes the actual Engine ComputeRenderCoords and complete ComputeRenderSize
in the hash-verified original DLL oracle. Only appTan's measured return and the
recorded render-device virtual callback are intercepted. Hardware's full
extended return is rounded to a qword before the Engine resumes; Unicorn's
transcendental approximation is never used as the tangent reference.

The 2026-09-23 run passed 15 original comparisons, checking all 12 coordinate
and five size/projection float32 bit patterns, each argument to appTan, and the
single render-device callback. Cases cover every admitted FOV, an external
72.25-degree service case, each cardinal rotation axis, mixed/wrapped/extreme
int32 rotators, nonzero and extreme camera origins, odd viewport dimensions,
and dimensions above float32's exact-integer range. The test also checks the
native-memory writer and explicit unsupported FOV/orthographic boundaries.
Hardware and original capture artifacts remain under ignored
`.cache/window-scene-frame/`; the driver skips explicitly when the required
hardware runner/compiler is unavailable.
