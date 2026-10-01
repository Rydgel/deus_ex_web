# appTan on the scene frame's FOV path

Engine's `ComputeRenderSize` turns `Actor.FOVAngle` into the projection
distance through Core `appTan` (thunk `0x101025c2`, body `0x10123260`:
`FLD m64`, `FPTAN`, `FSTP st(0)`, the extended result stored as a qword):
`x = double(FOV * 0.008726646259971648)` (FLD m32, FMUL m64, FSTP m64),
then `appTan(x)` ([scene frame](script-window-scene-frame.md)). Only seven FOVs
had measured results. The intro cinematic's camera eases the FOV through
values such as 74.99874°, which stopped `00_Intro`'s conversation
("Scene frame requires measured original appTan").

## Model

`src/runtime/x87-tan.mjs` `x87TanCandidates(x)` computes `tan(x)` for the exact
double `x` to 256 bits (BigInt Taylor series of sin and cos) and returns the
correctly rounded double. When the true tangent lies within 8 extended units
(2^-63 relative) of the halfway point between two doubles it returns both:
FPTAN's own error could store either. The scene frame uses the tangent only
through the float32 `projectionZ = float32(width * 0.5 / tan)`; it computes
that with each candidate and requires them to agree.

## Evidence (AMD Ryzen 9 8945HS, control word 0x037F, under Wine)

`tools/x87-tan-probe.c` computes the argument and appTan exactly as the
original (inline x87) for every integer FOV 1–179, every float32 within 2,000
units of 75 and of 90, and 200,000 pseudo-random float32 FOVs in [1, 179]:
208,181 rows. Against the model, `scripts/validate-x87-tan-hardware.mjs`
checks every row: the argument is the scene frame's; 206,623 single
candidates equal the hardware qword; the 1,558 pairs include it; every FOV
builds a frame at 1440×960 and 1024×768. FPTAN missed the correctly rounded
double 39 times, each within 0.581 extended units of the halfway point and at
every tangent size up to FOV 179, so the 8-unit band is about 14 times the
largest error seen. `test/x87-tan.test.mjs` checks the seven measured qwords
without Wine.

Not covered: Intel x87 (the original also ran on Intel CPUs; a disagreement
would be a finding), FOV outside (0°, 180°), and a frame whose two candidates
give different `projectionZ` (none in the sample; the frame throws).
