# Original arithmetic used by decoration contact

The authority is the installed Core.dll and the declarations in original
Object.uc. These are arithmetic operations reached by DeusExDecoration.Bump,
independent of decoration physics, sound, or AI event support.

| native | original body | recovered operation |
| ---: | --- | --- |
| 152 | `10133cd0` | signed dword `<=`, `setle` at `10133d33` |
| 153 | `10133da0` | signed dword `>=`, `setge` at `10133e03` |
| 159 | `10134280` | read out-int after evaluating B, multiply by float32 B, `_ftol`, store/result low dword |
| 161 | `10134480` | read out-int after B, wrapping dword addition, store then return new value |
| 162 | `10134570` | read out-int after B, wrapping dword subtraction, store then return new value |
| 178 | `10135460` | float comparison, true when x87 C0 or C3 is set, including unordered |
| 246 | `101364e0` | choose A if V<A or unordered; otherwise V if V<B or unordered; otherwise B |

Each wrapper evaluates arguments in declaration order in FFrame.Object context.
The out-int natives retain the first argument's property address across the
second expression, then read the current pointed-to value. If the first
expression produced no property address, they use its local temporary instead.
They consume EndFunctionParms before the final write and result store.

Native 159 uses `fildl` at `101342e5`, `fmuls` at `101342eb`, then the import
bridge `1016eec0 -> IAT 102ab4b8`, identified as MSVCRT `_ftol`. The established
ordinary finite conversion truncates the retained product toward zero to int64
and returns its low dword in EAX. The implementation uses the float32 operand's
exact significand/exponent with integer arithmetic so JS double rounding cannot
move a product across an integer boundary. Nonfinite/int64-overflow conversion
is explicitly unsupported until the imported routine's exceptional path is
recovered.

For 178, `fcomps` is followed by `testb $0x41,%ah` at `101354be`, so using JS
`<=` alone would lose the original unordered result. For FClamp, each branch
tests C0 alone (`10136563`, `10136582`); equal bounds follow the second/last
branch, and a NaN V selects A. These choices also preserve the selected input's
signed zero.

## Vector and rotator operations

Native 275 (`execLessLess_VectorRotator`, `10137d90`–`1013806f`) evaluates its
vector before its rotator, then composes inverse roll, pitch and yaw coordinates
with the original sine table. The three coordinate multiplication calls are
`10137e82`, `10137f21`, and `10137fc9`. This is the same recovered composition
used by `getAxes` (`src/runtime/camera.mjs`). The final instructions
`10137fff`–`10138053` form dot products against those three axes, storing each
component as float32. The vector has no origin subtraction.

Token 0x50 (`execVectorToRotator`, `10136f90`) evaluates one vector and calls
`FVector.Rotation` through thunk `10102888`, body `10144390`. That body computes
Yaw first from `appAtan2(Y,X)`, then Pitch from
`appAtan2(Z,appSqrt(X*X+Y*Y))`, and writes Roll=0. The squared XY sum and square
root cross explicit float64 argument stores, without float32 intermediates.
Both angles are multiplied by the exact stored float64 constant at `10178050`,
`10430.219195527361`, and truncated by `_ftol`. This constant corresponds to
65535 units per revolution; substituting 65536 would change cardinal results.
`appAtan2` (`10123280`) uses x87 FPATAN; `appSqrt` (`10123290`) uses FSQRT.
The JS translation uses the same formula, float stores, constant and truncation;
it does not claim to emulate exceptional/nonfinite x87 math.

## Float equality and inequality

The original declarations are `Object == (float,float)` native 180 and
`Object != (float,float)` native 181. Their export thunks are `10101e92` and
`10103184`; they jump to bodies `10135620` and `10135700`, respectively. Each
body evaluates both expressions in order through the Core expression jump table
`101f41b8`, loads the resulting four-byte float locals with `flds`, compares
them with `fcomps`, and reads the x87 status with `fnstsw`.

Native 180 tests only C3 (`testb $0x40,%ah` at `1013567e`), while native 181
tests the same bit and inverts the branch (`1013575e`–`10135761`). Therefore
native 180 returns true for ordered equality or an unordered comparison;
native 181 returns true only for ordered inequality. Either NaN makes 180 true
and 181 false. The operands are expression results stored as single precision
values, so the VM applies `Math.fround` before comparing; `+0` and `-0`
compare equal. NaN payload/signaling details are outside the recovered
contract.
