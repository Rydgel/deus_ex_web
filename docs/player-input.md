# Original walking input contract

Before translation: PlayerPawn.PlayerWalking.PlayerMove3623–3632 calls
GetAxes(body Rotation,X,Y,Z), then stores aForward*=float32(.4), aStrafe*=.4,
aLookup*=.24, aTurn*=.24. NewAccel=aForward*X+aStrafe*Y uses separate vector
multiply results followed by vector addition, each component float32; then Z=0.
There is no normalization in this script expression. Body Rotation is the integer
rotation before UpdateRotation later in this same PlayerMove call (3710 onward).
The axes are Core.GetAxes, using recovered quantized GMath sine-table coordinates;
continuous incoming camera yaw does not implement this order.

DeusExPlayer.PlayerWalking.ProcessMove3422 assigns int defSpeed from
GetCurrentGroundSpeed() (float to int). Healthy standalone, with no carried
Decoration, heavy weapon, POVCorpse or movement-affecting augment: newSpeed is
that integer. If aForward<0, native int*=float32(.65) applies, then
GroundSpeed=FMax(float(newSpeed),100). This integer truncation can differ from
GroundSpeed*.65 in browser arithmetic. Crouch sets bIsWalking but does not scale
GroundSpeed here; native walking applies WalkingPct separately. The helper's
currentGroundSpeed is the original function's resolved result, not a guessed
constant. GetCurrentGroundSpeed3292–3313 returns0 for absent AugmentationSystem,
otherwise Default.GroundSpeed times resolved AugSpeed (sentinel-1 becomes1).

This bounded helper supports healthy standalone speed only. Health damage,
carried objects, weapon effects, multiplayer, spy drone and augmentation resolution
remain caller responsibilities; browser keyboard/analog-to-aForward/aStrafe is an
explicit input boundary. Their presence must not silently select the healthy
speed calculation. NewAccel is still usable independently of that speed helper.

API: `walkingInput({rotation,aForward,aStrafe,aLookup=0,aTurn=0})` returns the
four scaled inputs and `newAccel`. `healthyWalkingGroundSpeed(currentGroundSpeed,
aForward)` implements only the healthy speed branch above. Serialized inherited
JCDentonMale defaults resolve GroundSpeed320, AccelRate1000, and both legs/torso
health100. AccelRate is a separate native acceleration clamp, not the script
axis multiplier. Input6000 becomes2400 before that later native work. Healthy
backward GroundSpeed320 becomes207: float32(.65)*320 is below208 and int*=float
truncates it. Passing a decimal currentGroundSpeed first truncates defSpeed.
DeusExPlayer.ProcessMove3662 ultimately calls Super.ProcessMove; inherited
PlayerPawn.ProcessMove assigns Acceleration=NewAccel before jumping/stance work.

Reference capture preceded helper implementation. The native harness uses the
original Core GetAxes export0x10102d06, FloatToInt0x10102d15,
MultiplyEqual_IntFloat0x10101bf9→0x10134280, Multiply_FloatVector0x10102897,
Add_VectorVector0x101029a5 and source-selected float scalar operations. Out-variable
binding is supplied by research stubs; all numeric expressions execute original
instructions. It does not claim to execute whole PlayerMove or ProcessMove bytecode.
`NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node
scripts/validate-native-player-input.mjs` passes132 exact original comparisons,
including quantization boundaries, negative/wrapped yaw, pitched/rolled rotators,
analog inputs, fractional speed, backward truncation and the100 floor. Four focused
tests pass. Keyboard/mouse input accumulation, UpdateRotation integration, health
and equipment branches, and whole-game observation remain outside this capture.
