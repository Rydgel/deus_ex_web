# Original script decoding

Authority: supplied Core.dll UStruct.SerializeExpr, export1010281f → body101289c0,
with token jump table10128e44. Input hash is the existing Core hash recorded in
the native-oracle helpers. The disassembly stays in ignored
`.cache/research/SerializeExpr-stage3.asm`.

The serializer advances a separate expanded script offset. Object and name
references use archive virtual slots+18/+1c and occupy four runtime bytes,
irrespective of compact serialized index length. Branch and skip distances are
uint16; literals retain their actual 1/4/12-byte widths. Native tokens >=70 read
arguments until16; 60–6f first read an additional native-index byte. Conversions
39–5f recursively serialize one expression. LabelTable0c begins on a four-byte
boundary after its opcode and contains name/uint32-offset pairs through None.

`decodeScript` preserves both expanded offsets and serialized offsets, original
field/object/name indices, nested expressions and top-level instruction
boundaries. Resolving a field by short name is a compatibility adapter for the
old CheckBob VM, not the general object-identity contract. Execution, lookup,
parameter copying and native dispatch belong to the VM/runtime.

The initial decoder targets version68/69 game scripts. Unknown/reserved tokens
and the unneeded Unicode-string token remain explicit errors until their
execution/encoding contract is required and established. Serialized token2d is
a prefix for the following variable operation at execution; the execution-tree
decoder retains that variable as its child (execBoolVariable1012f300).

The first additional scalar operations follow original Core.Object native
declarations. Native146 adds signed32 integers and stores the wrapping32-bit
result (1013384f–52); native154 uses integer comparison (10133ecd–d6), and
native119 compares object pointers (1013ca6d–76). ByteToInt masks255
(101310ad–b3); ByteToFloat masks255 then fild/fstp (101311ed–fb); IntToFloat uses
signed fild/fstp (10131588–90). Their JS counterparts retain these type widths.

FloatToByte token43 uses export thunk `101019ec`, body `10131aa0`. It evaluates
the operand into a zero-initialized four-byte float local, loads it with `flds`
at `10131ac8`, calls the already identified MSVCRT `_ftol` import bridge
`1016eec0 -> IAT 102ab4b8`, then stores only AL (`10131ad5`). The ordinary
finite path truncates toward zero to int64 and keeps the low byte; it does not
clamp to 0–255. The VM rounds its input to float32 first. A nonfinite or
int64-overflow input stores `_ftol`'s integer indefinite, so the byte is 0
(docs/script-numeric-conversions.md).
The original TriggerLight.Tick uses this conversion at expanded offset164
when assigning `Alpha * InitialBrightness` to the byte LightBrightness.

The mover primitive extension keeps Core.Object's declared signed integer,
vector and rotator operations. IntToByte writes the low byte (1013144c–50).
Post-increment native165 returns the old integer then increments its storage
(1013482c–31); a non-variable argument uses native temporary storage. Clamp251
tests the lower bound first, then the upper bound (10134c60–79), including when
the bounds are reversed. FMin244 selects A unless A>B (1013637e–99); FMax245
selects A when A>=B, B otherwise (1013645e–79). These explicit branches preserve
equal signed-zero and unordered comparisons that Math.min/Math.max would change.

`compileFunction.createFrame` exposes the instruction cursor separately from
function invocation. A state frame can stop or suspend after a native statement
installs a latent action. `ScriptState` searches label tables through the selected
state's superclass chain, clears a pending latent action on every label request,
and keeps the selected state separate from the node containing inherited code.
GotoLabel1012eb19–7d establishes these operations, including clearing Code on a
missing label. ProcessState's already recovered polling order is documented in
`door-state.md`. Class/state selection events and generic actor scheduling are
separate runtime work; a resumable frame alone does not implement those systems.

`ScriptObjects` interns resolved exports using their full case-insensitive
package/object key. Two imports of the same object therefore compare as the same
object, matching native pointer equality. It links operands before synchronous
script execution and retains property/function/class/resource provenance. This
is the linker's object identity, not actor spawning or a claim of garbage
collection/lifecycle support; those require the subsequent runtime layer.
