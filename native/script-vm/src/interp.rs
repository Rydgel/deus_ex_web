//! The statement loop and typed expression evaluator (docs/rust-core.md,
//! step R2b-2). The lowered word code and its semantics are the contract with
//! the JavaScript lowering pass (script-vm-lower.mjs); every kind transcribes
//! the JavaScript VM's closure for the same original node (script-vm.mjs:
//! `native` for the operators, `compileEv`/`compileAssign` for variables,
//! contexts and conversions, `resumeCompiled` for the statement loop). A node
//! this file has no kind for is lowered to a `JS_*` kind, which evaluates the
//! original node with the JavaScript closures on the same frame.
//!
//! Values: int, byte and bool as i32/bool; float as f64, the JavaScript
//! number the closures carry (so `Math.fround(a * b)` is
//! `((a * b) as f32) as f64`), with `UNDEF_F64` standing for a JavaScript
//! undefined; object as a handle (script-object-handles.mjs), 0 for None and
//! `UNDEFINED` for a JavaScript undefined.
//!
//! Re-entrancy: an import may run another script function, which enters
//! `vm_run` again, and a CALL runs its callee as a nested `Run` in the same
//! invocation. Each run's state lives in its own `Run` on the shadow stack;
//! only the words the host synchronizes are statics.
//!
//! Stores (effects, after S_EXPR). A local store writes the frame block at
//! `locals + off`. A SELF field store (`off, node, key, len`, then the value)
//! selects the storage first with the field fast-path rule; a field on the
//! JavaScript path skips the `len` value words unevaluated and runs `node`
//! (the whole original node) with js_eval. The value is then evaluated with
//! SELF as receiver and stored by the property codec: int as the word, byte
//! as its low byte, bool merged into the word read after the value, float as
//! its f32 bits (UNDEF_F64 as 0.0), object as the handle word (UNDEFINED as
//! 0: copyPointer's `value ?? null`, then the POINTER cell's handle).
//! * SET_LOCAL_OBJECT 68 `off`; SET_FIELD_OBJECT 69 `off, node, key, len`
//!   (never Actor.Base, whose JavaScript store bumps an epoch).
//! * COMPOUND_LOCAL 56 `op, off`; COMPOUND_FIELD 57 `op, off, node, key,
//!   len` (`node` the out native's call node): a statement `X op= V` on a
//!   local or SELF field (compileNative evaluates X as a reference, then V,
//!   then the native reads X). An unknown `op` fails first with ERR_KIND.
//!   After the storage: `b` = V, then `a` = the target's current value, then
//!   the store. Ops: 1 `+=` float (native 184) f(a + b); 2 `-=` float (185)
//!   f(f(a) - f(b)); 3 `*=` float (182) f(a * b), with `a` the widened f32
//!   and `b` a float value (UNDEF_F64 computes as JavaScript's NaN from
//!   undefined, never as a store's 0); 4 `+=` int (161) and 5 `-=` int (162),
//!   wrapping i32.
//!
//! Compares added with the stores: INT_LE 96 / INT_GE 113 (natives 152/153,
//! signed); FLOAT_LE 127 (native 178) `!(f(a ?? 0) > f(b ?? 0))`: UNDEF_F64
//! counts as 0.0 before the fround (the raw compares 125/126/128 do not), a
//! NaN stays NaN, so an unordered pair is true.
//!
//! Float operators (R2b-5): FLOAT_MUL/DIV/ADD/SUB return `f(a op b)` with a
//! NaN result made the x87's explicitly (`x87_nan`): the larger float32
//! significand of a NaN pair (the positive NaN on a tie), a lone NaN operand,
//! quieted, or the indefinite 0xFFC00000 for an invalid operation.
//!
//! Handle slots (docs/map-memory.md "The handle tables"). The per-runtime
//! handle tables (CLASSES, RECEIVERS, natives.rs STATES) hold one entry per
//! slot, not per handle: handles are never reused (script-object-handles.mjs),
//! so tables indexed by handle covered every handle the process had ever
//! allocated. HANDLES = [first, old keys, old capacity, old shift]
//! (script-vm-handle-slots.mjs): `first` is the handle limit when the level's
//! interpreter attached. A handle at or above it has slot `old capacity +
//! handle - first` while `handle - first` is below the table's capacity (its
//! window); a handle below it that was live then is a key of the old part,
//! `old capacity` u32 keys (a power of two, 0 empty, linear probing from
//! `handle * 0x9E3779B1 >> old shift`), and its slot is its position there.
//! Any other handle below `first` had been released when the level started
//! and has no slot: its class entry is RELEASED. Every table has `old
//! capacity` slots before its window. All words 0 (no old part, `first` 0)
//! is the table indexed by handle.
//!
//! Handle classes (R2b-5). CLASSES = [table, capacity] is a per-runtime u32
//! table indexed by handle slot: 0 (not described), RELEASED (the handle's
//! identity ended; a pointer holding it reads None, as identityOfHandle's
//! null does), or the address of the class row of the handle's attached
//! instance (`instances.get(identity).cls`), written by js_class_row. A row
//! is [default image, n, record id of cls, of cls.base, ...] (then R2b-6's
//! name ids and R3-c's two perception words, percep.rs). Its default
//! image word is 0 when the host must look again (a class default or class
//! image changed), UNREADABLE when DefaultVariable reads of that class stay
//! in JavaScript, else the base of the class default image. A handle released
//! since the level started is inside the window or the old part, one released
//! before it has no slot, so a handle at or beyond the window is live.
//!
//! Receiver table. RECEIVERS = [table, capacity, epoch, verify] is a
//! per-runtime table of four u32 per handle slot, [info, epoch, binding set,
//! 0]: the receiver info js_receiver returned for the handle and the host's
//! receiver epoch when it did (receiver-epoch.mjs). An entry whose epoch is
//! the current one is the info js_receiver would return now, because the host
//! advances the epoch on every event that can change it and clears a released
//! handle's entry; any other entry, a handle without a slot, and every lookup
//! while `verify` is set (RECEIVER_VERIFY=1) ask js_receiver, which enters
//! the answer.
//! * Object reads from memory (LOCAL_OBJECT, FIELD_OBJECT, *_ELEM_OBJECT)
//!   go through `live`: a released handle reads as None.
//! * DYNAMIC_CAST 73 `rid, node`, then the object value (compileEv 0x2e,
//!   castObject 'dynamic'): the value is evaluated with SELF; None or
//!   undefined casts to None; rid 0 (target None) is the value; a described
//!   handle is the value when its row lists `rid` (`cls.record === target`
//!   along `cls.base`), else None; any other handle goes to js_cast, which
//!   runs castObject itself (a released SELF handle included: the closure
//!   casts `fr.instance`).
//! * DEFAULT_INT/BYTE/BOOL/FLOAT 45-48 `off, node, owner, [mask]` (compileEv
//!   0x02, defaultReference): the class default image of the receiver's class
//!   at `off` when the receiver is not HOST, its row's image is readable and
//!   the row lists `owner` (the record id of the class declaring the
//!   property, so the property is in the class's PropertyLink); otherwise
//!   `node` in JavaScript, which also raises the closure's errors.
//! * FIELD_ELEM_INT/BYTE/BOOL/FLOAT/OBJECT 25-29 `off, stride, dim, node,
//!   key, [mask]` and LOCAL_ELEM_* 35-39 `off, stride, dim, node, [mask]`,
//!   then the index (EX_ArrayElement read, compileEv 0x1a, or a scalar member
//!   of its element, 0x36 over 0x1a: `off` includes the member's offset).
//!   The index is evaluated first with SELF, as the closure does; the
//!   lowering admits only an index without imports (a literal or a local),
//!   so evaluating it again on the JavaScript path is unobservable. Then the
//!   storage: a field on the JavaScript path, or an index outside [0, dim)
//!   (arrayReference's ArrayIndexOutOfBounds warning and clamp), evaluates
//!   `node` in JavaScript; otherwise the element at `off + index * stride`.
//!
//! STRUCT_ARRAYS (docs/firefox-60fps-plan.md "Tick hand-backs"): a struct local's fixed-array member (`projList.List[i].dist`) is a local
//! array at the struct's offset plus the member's, so the LOCAL_ELEM_* reads above serve it; LOCAL_ELEM_VECTOR 209 `off, stride, dim,
//! node` then the index reads a vector element or a vector member of an element (three quiet words, or the closure for an index
//! outside [0, dim)); SET_LOCAL_ELEM 210 `sub, off, stride, dim, node, check, len`, the index, then `len` words of value, stores a
//! scalar (E_INT, E_BYTE, E_FLOAT, E_OBJECT) or vector (E_VECTOR) element: the index first (compileAssign evaluates the target's
//! reference before the value), the value, then the element's bytes; an index outside [0, dim) runs the whole Let `node` in
//! JavaScript with the value unevaluated. `check` is the target's node: under SCRIPT_VM_CHECK or STRUCT_ARRAYS=verify (FEATURES
//! word 2) the stored element is read back through the closure of that node and compared. P_VECTOR 7 / P_ROTATOR 8 call parameters
//! store a vector (the three quiet words of `vector()`) or rotator as SET_LOCAL_VECTOR / SET_LOCAL_ROTATOR store theirs; P_STRUCT_IN 9
//! is P_STRUCT's copy in with no copy back (a struct passed by value).
//!
//! SCRIPT_VM_CHECK (CHECK nonzero): each of the R2b-5 reads above that Rust
//! completes calls js_check with its value, and the host compares it with
//! what the closure computes (castObject on the evaluated value for a cast).
//!
//! State code (R2b-5): `vm_statement` runs one lowered statement of a state
//! frame (S_EXPR, S_JUMP, S_JUMP_IF_NOT, S_NOTHING) for the host's copy of
//! resumeCompiled's loop, which counts the budget, advances the cursor and
//! checks the latent action, the cursor and the iterators between
//! statements. It returns 1 when a jump is taken (the host sets the cursor to
//! the statement's target), else 0.
//!
//! Vectors, rotators and names (R2b-6, `.work/notes/r2b6-spec.md`).
//! * Values. A vector is `[u32; 3]`, the float32 bit patterns of X, Y, Z, each
//!   NaN quiet: the JavaScript value is an Array of three float32 numbers
//!   (codec copies and operator results), and a float32 cell read quiets a
//!   signaling NaN (`getFloat32` widens), so memory loads set the quiet bit
//!   explicitly (`quiet`). A rotator is `[i32; 3]`. A name is the id of its
//!   folded spelling `String(v || 'None').toLowerCase()`, interned for every
//!   runtime by the host (id 1 = `none`): exactly what 254/255 and IsA
//!   compare, and no Rust consumer needs the spelling.
//! * JavaScript values: js_vector / js_rotator write the closure's value to
//!   VECTOR_IO (the host throws on a value that is not three float32 numbers
//!   or three int32 words; the lowering only admits JavaScript nodes whose
//!   value is a codec copy); js_name returns the name id.
//! * Kinds (operator nodes carry the native call's `node`; operands evaluate
//!   left to right with SELF). Vector: LIT_VECTOR 160 `x, y, z`, LOCAL_VECTOR
//!   161 `off, node`, FIELD_VECTOR 162 `off, node, key`, JS_VECTOR 163,
//!   VECTOR_ADD/SUB 164/165 (215/216 `f(a_i op b_i)`), VECTOR_SCALE 166 (212
//!   `f(f(a_i) * f(s))`), SCALE_VECTOR 167 (213 `f(f(s) * f(b_i))`),
//!   VECTOR_DIVIDE 168 (214, the kernel's DivideEqual_VectorFloat body),
//!   VECTOR_NEG 169 (211, sign flip), and the x87 kernel bodies VECTOR_MUL 170
//!   (296), VECTOR_NORMAL 171 (226), VECTOR_MIRROR 172 (300), VECTOR_ROTATE 173
//!   (276). Rotator: LIT_ROTATOR 175, LOCAL_ROTATOR 176, FIELD_ROTATOR 177,
//!   JS_ROTATOR 178, ROTATOR_ADD/SUB 179/180 (316/317), ROTATOR_SCALE 181
//!   (287) and SCALE_ROTATOR 182 (288, kernel). Scalars: VECTOR_MEMBER 183
//!   `node, index` (float) and ROTATOR_MEMBER 184 `node, index` (int),
//!   EX_StructMember over a value evaluated with the member's receiver; VECTOR_SIZE 185 (225,
//!   doubles and a correctly rounded sqrt), VECTOR_DOT 186 (219, kernel),
//!   VECTOR_EQ/NE 187/188 (217/218), ROTATOR_EQ/NE 189/190 (142/203),
//!   NAME_EQ/NE 191/192 (254/255), IS_A 193 `node, name` (303 with a literal).
//!   Names: LIT_NAME 194 `id`, JS_NAME 195. A float operand that is UNDEF_F64
//!   is JavaScript's undefined, whose fround is NaN. A NaN result is the
//!   x87's (`x87_nan`).
//! * Stores: SET_LOCAL_VECTOR 196 / SET_LOCAL_ROTATOR 198 `off`;
//!   SET_FIELD_VECTOR 197 / SET_FIELD_ROTATOR 199 `off, node, key, len` (as
//!   set_field); VCOMPOUND_LOCAL 156 `op, off, node` and VCOMPOUND_FIELD 157
//!   `op, off, node, key, len` (the out natives 221, 222, 223, 224, 297, 318,
//!   319 as statements, ordered as COMPOUND: storage, value, target, store;
//!   `node` is the native call).
//! * CONTEXT with a None object yields [0, 0, 0] (vector, rotator) or the
//!   name `none`.
//! * S_RETURN_ITER 9: a Return in a body with a foreach; js_iterators first
//!   (a nonzero count fails with ERR_RETURN_ITERATOR, stepCompiled's 'Return
//!   requires compiled iterator unwind'), then S_RETURN. R_VECTOR 5 and
//!   R_ROTATOR 6 return through RESULT3 (RESULT = 0.0).
//! * IS_A: a HOST receiver or a handle the class table does not describe
//!   evaluates `node` in JavaScript; otherwise whether the class row's name
//!   list (`[image, n, rids.., names..]`) holds `name`.
//! * SCRIPT_VM_CHECK: a vector or rotator read from memory reports CK_VECTOR /
//!   CK_ROTATOR with the value in CHECK_VALUES[6..9]; an operator, a member
//!   of a value and an out native report CK_OP with the operands in
//!   CHECK_VALUES[0..3] and [3..6] and the result in [6..9], and the host runs
//!   the JavaScript VM's own code on those operands (the native() body,
//!   structValue); IS_A reports CK_BOOL.
//!
//! Perception natives (R3-c, percep.rs): PAWN_ENEMY 200 (bool, 2105),
//! PAWN_ALLIANCE 201 (int, 2107) and AI_CAN_SEE 202 (float, 705), each
//! `node, argc`, then per argument a presence word (0 for EX_Nothing) and,
//! when present, its code; the receiver is the node's receiver.
//!
//! Small natives (October 1, natives.rs): STATE_NAME 203 (name, 284),
//! LAST_RENDERED 204 (float, 723) and IN_STASIS 205 (bool, 721), on the
//! node's receiver; GetStateName reads the state table (STATES).

use core::ptr::{addr_of, addr_of_mut, read_unaligned, write_unaligned};

pub(crate) const UNDEFINED: u32 = u32::MAX;
pub(crate) const UNDEF_F64_BITS: u64 = 0x7ff8_0000_0000_0001;
/// js_step: the callee returned in JavaScript (RESULT written there).
const RETURNED: u32 = 0xffff_fffe;

// Statement kinds.
const S_EXPR: u32 = 1;
const S_JUMP: u32 = 2;
const S_JUMP_IF_NOT: u32 = 3;
const S_RETURN: u32 = 4;
const S_NOTHING: u32 = 5;
const S_YIELD: u32 = 6;
// IteratorNext / IteratorPop of a foreach whose Iterator statement ran in
// JavaScript: the host keeps the frame's iterator stack.
const S_ITER_NEXT: u32 = 7;
const S_ITER_POP: u32 = 8;
// A Return in a body with a foreach (R2b-6).
const S_RETURN_ITER: u32 = 9;
// A foreach over CycleActors whose iterator Rust owns (iter.rs).
const S_FOREACH_CYCLE: u32 = 10;
// Expression kinds.
const LIT_INT: u32 = 20;
const LIT_FLOAT: u32 = 21;
const LIT_BOOL: u32 = 23;
const LIT_NONE: u32 = 24;
const FIELD_ELEM_INT: u32 = 25;
const FIELD_ELEM_BYTE: u32 = 26;
const FIELD_ELEM_BOOL: u32 = 27;
const FIELD_ELEM_FLOAT: u32 = 28;
const FIELD_ELEM_OBJECT: u32 = 29;
const LOCAL_INT: u32 = 30;
const LOCAL_BYTE: u32 = 31;
const LOCAL_BOOL: u32 = 32;
const LOCAL_FLOAT: u32 = 33;
const LOCAL_OBJECT: u32 = 34;
const LOCAL_ELEM_INT: u32 = 35;
const LOCAL_ELEM_BYTE: u32 = 36;
const LOCAL_ELEM_BOOL: u32 = 37;
const LOCAL_ELEM_FLOAT: u32 = 38;
const LOCAL_ELEM_OBJECT: u32 = 39;
const FIELD_INT: u32 = 40;
const FIELD_BYTE: u32 = 41;
const FIELD_BOOL: u32 = 42;
const FIELD_FLOAT: u32 = 43;
const FIELD_OBJECT: u32 = 44;
const DEFAULT_INT: u32 = 45;
const DEFAULT_BYTE: u32 = 46;
const DEFAULT_BOOL: u32 = 47;
const DEFAULT_FLOAT: u32 = 48;
const JS_INT: u32 = 50;
const JS_BOOL: u32 = 52;
const JS_FLOAT: u32 = 53;
const JS_OBJECT: u32 = 54;
const JS_VOID: u32 = 55;
const COMPOUND_LOCAL: u32 = 56;
const COMPOUND_FIELD: u32 = 57;
const SET_LOCAL_INT: u32 = 60;
const SET_LOCAL_BYTE: u32 = 61;
const SET_LOCAL_BOOL: u32 = 62;
const SET_LOCAL_FLOAT: u32 = 63;
const SET_FIELD_INT: u32 = 64;
const SET_FIELD_BYTE: u32 = 65;
const SET_FIELD_BOOL: u32 = 66;
const SET_FIELD_FLOAT: u32 = 67;
const SET_LOCAL_OBJECT: u32 = 68;
const SET_FIELD_OBJECT: u32 = 69;
const CONTEXT: u32 = 70;
const SELF_OBJECT: u32 = 71;
const CALL: u32 = 72;
const DYNAMIC_CAST: u32 = 73;
const NOT: u32 = 80;
const AND: u32 = 81;
const OR: u32 = 82;
const BOOL_NE: u32 = 83;
const BOOL_EQ: u32 = 84;
const INT_ADD: u32 = 90;
const INT_SUB: u32 = 91;
const INT_MUL: u32 = 92;
const INT_LT: u32 = 93;
const INT_GT: u32 = 94;
const INT_DIV: u32 = 95;
const INT_LE: u32 = 96;
const INT_EQ: u32 = 97;
const INT_NE: u32 = 98;
const INT_AND: u32 = 99;
const INT_XOR: u32 = 100;
const INT_OR: u32 = 101;
const INT_NEG: u32 = 102;
const INT_NOT: u32 = 103;
const INT_SHL: u32 = 104;
const INT_SAR: u32 = 105;
const INT_SHR: u32 = 106;
const INT_MIN: u32 = 107;
const INT_MAX: u32 = 108;
const INT_CLAMP: u32 = 109;
const INC_LOCAL_PRE: u32 = 110;
const DEC_LOCAL_PRE: u32 = 111;
const INC_LOCAL_POST: u32 = 112;
const INT_GE: u32 = 113;
const FLOAT_MUL: u32 = 120;
const FLOAT_DIV: u32 = 121;
const FLOAT_ADD: u32 = 122;
const FLOAT_SUB: u32 = 123;
const FLOAT_NEG: u32 = 124;
const FLOAT_LT: u32 = 125;
const FLOAT_GT: u32 = 126;
const FLOAT_LE: u32 = 127;
const FLOAT_GE: u32 = 128;
const FLOAT_EQ: u32 = 129;
const FLOAT_NE: u32 = 130;
const FLOAT_NEAR: u32 = 131;
const FLOAT_MIN: u32 = 132;
const FLOAT_MAX: u32 = 133;
const OBJECT_EQ: u32 = 140;
const OBJECT_NE: u32 = 141;
const BYTE_TO_INT: u32 = 150;
const INT_TO_BYTE: u32 = 151;
const INT_TO_FLOAT: u32 = 152;
const BYTE_TO_FLOAT: u32 = 153;
const FLOAT_TO_INT: u32 = 154;
const FLOAT_TO_BYTE: u32 = 155;
// R2b-6: vectors, rotators and names.
const VCOMPOUND_LOCAL: u32 = 156;
const VCOMPOUND_FIELD: u32 = 157;
const LIT_VECTOR: u32 = 160;
const LOCAL_VECTOR: u32 = 161;
const FIELD_VECTOR: u32 = 162;
const JS_VECTOR: u32 = 163;
const VECTOR_ADD: u32 = 164;
const VECTOR_SUB: u32 = 165;
const VECTOR_SCALE: u32 = 166;
const SCALE_VECTOR: u32 = 167;
const VECTOR_DIVIDE: u32 = 168;
const VECTOR_NEG: u32 = 169;
const VECTOR_MUL: u32 = 170;
const VECTOR_NORMAL: u32 = 171;
const VECTOR_MIRROR: u32 = 172;
const VECTOR_ROTATE: u32 = 173;
const LIT_ROTATOR: u32 = 175;
const LOCAL_ROTATOR: u32 = 176;
const FIELD_ROTATOR: u32 = 177;
const JS_ROTATOR: u32 = 178;
const ROTATOR_ADD: u32 = 179;
const ROTATOR_SUB: u32 = 180;
const ROTATOR_SCALE: u32 = 181;
const SCALE_ROTATOR: u32 = 182;
const VECTOR_MEMBER: u32 = 183;
const ROTATOR_MEMBER: u32 = 184;
const VECTOR_SIZE: u32 = 185;
const VECTOR_DOT: u32 = 186;
const VECTOR_EQ: u32 = 187;
const VECTOR_NE: u32 = 188;
const ROTATOR_EQ: u32 = 189;
const ROTATOR_NE: u32 = 190;
const NAME_EQ: u32 = 191;
const NAME_NE: u32 = 192;
const IS_A: u32 = 193;
const LIT_NAME: u32 = 194;
const JS_NAME: u32 = 195;
const SET_LOCAL_VECTOR: u32 = 196;
const SET_FIELD_VECTOR: u32 = 197;
const SET_LOCAL_ROTATOR: u32 = 198;
const SET_FIELD_ROTATOR: u32 = 199;
// R3-c: the perception natives (percep.rs).
const PAWN_ENEMY: u32 = 200;
const PAWN_ALLIANCE: u32 = 201;
const AI_CAN_SEE: u32 = 202;
// October 1: small natives (natives.rs).
const STATE_NAME: u32 = 203;
const LAST_RENDERED: u32 = 204;
const IN_STASIS: u32 = 205;
// GetPlayerPawn (720) over the host-maintained cell (natives.rs player_pawn).
const PLAYER_PAWN: u32 = 207;
// A script call with struct out arguments (iter.rs).
const CALL_OUT: u32 = 208;
// STRUCT_ARRAYS: a vector element of a local fixed array (or of a struct local's fixed-array member), and a store to a scalar or
// vector element of one.
const LOCAL_ELEM_VECTOR: u32 = 209;
const SET_LOCAL_ELEM: u32 = 210;
// SET_LOCAL_ELEM's value kinds.
const E_INT: u32 = 1;
const E_BYTE: u32 = 2;
const E_FLOAT: u32 = 3;
const E_OBJECT: u32 = 4;
const E_VECTOR: u32 = 5;
// Actor.SetRotation (native 299) as a statement, on SELF or a context object.
const SET_ROTATION: u32 = 211;

// COMPOUND_LOCAL / COMPOUND_FIELD ops.
const C_FLOAT_ADD: u32 = 1;
const C_FLOAT_SUB: u32 = 2;
const C_FLOAT_MUL: u32 = 3;
const C_INT_ADD: u32 = 4;
const C_INT_SUB: u32 = 5;
// VCOMPOUND_LOCAL / VCOMPOUND_FIELD ops (the out natives).
const V_MUL_FLOAT: u32 = 1;
const V_DIV_FLOAT: u32 = 2;
const V_ADD: u32 = 3;
const V_SUB: u32 = 4;
const V_MUL: u32 = 5;
const R_ADD: u32 = 6;
const R_SUB: u32 = 7;

// Receiver info: the image base with flags in the low bits (bases are
// 16-byte aligned). BOUND: the instance has host bindings, so a field whose
// key is marked in the bound-keys table takes the JavaScript path. HOST:
// every field does (no image, a poisoned value, a released allocation, a
// class receiver).
pub(crate) const BOUND: u32 = 1;
pub(crate) const HOST: u32 = 2;
// A class table entry for a released handle; a class row's default image
// word when DefaultVariable reads of that class stay in JavaScript. (Rows and
// images are arena addresses, never 1.)
pub(crate) const RELEASED: u32 = 1;
const UNREADABLE: u32 = 1;
// js_check value kinds.
const CK_INT: u32 = 1;
pub(crate) const CK_BOOL: u32 = 2;
pub(crate) const CK_FLOAT: u32 = 3;
pub(crate) const CK_OBJECT: u32 = 4;
const CK_CAST: u32 = 5;
const CK_VECTOR: u32 = 6;
const CK_ROTATOR: u32 = 7;
const CK_OP: u32 = 8;
pub(crate) const CK_NAME: u32 = 9;
/// The name id of `none` (the host interns it first).
pub(crate) const NAME_NONE: u32 = 1;

// Errors raised through js_error, which throws the JavaScript VM's message.
const ERR_HANG: u32 = 1;
const ERR_RUNAWAY: u32 = 2;
const ERR_OUTSIDE: u32 = 3;
const ERR_KIND: u32 = 4;
const ERR_DIV_OVERFLOW: u32 = 5;
const ERR_RETURN_ITERATOR: u32 = 8;
pub(crate) const ERR_OUT_STRUCT: u32 = 9;
pub(crate) const ERR_FOREACH: u32 = 10;

// CALL result kinds (also S_RETURN's) and argument kinds.
const R_VOID: u32 = 0;
const R_INT: u32 = 1;
const R_BOOL: u32 = 2;
const R_FLOAT: u32 = 3;
const R_OBJECT: u32 = 4;
const R_VECTOR: u32 = 5;
const R_ROTATOR: u32 = 6;
const P_SKIP: u32 = 0;
pub(crate) const P_INT: u32 = 1;
pub(crate) const P_BOOL: u32 = 2;
pub(crate) const P_FLOAT: u32 = 3;
const P_OBJECT: u32 = 4;
pub(crate) const P_BYTE: u32 = 5;
pub(crate) const P_STRUCT: u32 = 6;
// STRUCT_ARRAYS: a vector or rotator parameter, and a struct passed by value (copied in like P_STRUCT, not copied back).
const P_VECTOR: u32 = 7;
const P_ROTATOR: u32 = 8;
pub(crate) const P_STRUCT_IN: u32 = 9;

/// Core's runaway-loop limit (script-vm.mjs SCRIPT_RUNAWAY_LIMIT).
const RUNAWAY_LIMIT: u32 = 10_000_000;
/// resumeCompiled's hang guard: each script frame's statement budget.
pub(crate) const HANG_BUDGET: u32 = 200_000_000;
/// 2^63: `_ftol`'s int64 range, the JavaScript conversions' boundary.
const TWO_63: f64 = 9_223_372_036_854_775_808.0;

#[link(wasm_import_module = "env")]
extern "C" {
    /// SET_ROTATION=verify: what Rust decided for the SetRotation native `node` on `receiver` (0 left alone, 1 unchanged, 2 JavaScript, 3 stored)
    /// for the requested rotation, which the host decides again from readNamed.
    fn js_set_rotation_check(frame: u32, node: u32, receiver: u32, decision: u32, pitch: u32, yaw: u32, roll: u32);
    fn js_int(frame: u32, node: u32, receiver: u32) -> i32;
    fn js_float(frame: u32, node: u32, receiver: u32) -> f64;
    fn js_bool(frame: u32, node: u32, receiver: u32) -> i32;
    fn js_object(frame: u32, node: u32, receiver: u32) -> u32;
    fn js_eval(frame: u32, node: u32, receiver: u32);
    pub(crate) fn js_receiver(handle: u32) -> u32;
    fn js_accessed_none(frame: u32, node: u32);
    fn js_error(frame: u32, code: u32, node: u32);
    fn js_iterator_next(frame: u32) -> u32;
    fn js_iterator_pop(frame: u32);
    fn js_call_begin(frame: u32, node: u32, receiver: u32, sig: u32) -> i32;
    fn js_step(frame: u32, index: u32) -> u32;
    /// A body with locals that need destruction (STRING_FRAMES) has returned: callFunction's / processEvent's destroyFunctionLocals.
    pub(crate) fn js_run_end(frame: u32, template: u32);
    fn js_frame_advance(size: u32);
    pub(crate) fn js_class_row(handle: u32) -> u32;
    fn js_cast(frame: u32, node: u32, handle: u32) -> u32;
    fn js_check(frame: u32, node: u32, handle: u32, kind: u32, value: f64);
    fn js_vector(frame: u32, node: u32, receiver: u32);
    fn js_rotator(frame: u32, node: u32, receiver: u32);
    fn js_name(frame: u32, node: u32, receiver: u32) -> u32;
    fn js_iterators(frame: u32) -> u32;
}

// The words the host synchronizes. RUNAWAY is the JavaScript VM's
// scriptRunaway (the host writes it before each entry and after each import
// returns, and reads it back); BUDGET the remaining hang budget; RESULT a
// typed Return's value; FLOAT_UNDEF set by js_float when its value was
// undefined; BOUND_KEYS [table address, length] of the bound field keys;
// FRAMES the frame-block FMemStack [chunk index, top, end], shared with the
// JavaScript FrameStack (script-frame-locals.mjs), then the host's count of
// active runs (the next run id), restored with the stack after a call;
// CALL_BLOCK [callee locals,
// callee code, callee SELF, callee probe index, destroy template (0: none)], written by js_call_begin; CLASSES [table
// address, capacity] of the handle class table; RECEIVERS [table address,
// capacity, epoch, verify] of the receiver table; CHECK nonzero under
// SCRIPT_VM_CHECK.
static mut RUNAWAY: u32 = 0;
pub(crate) static mut BUDGET: u32 = 0;
static mut RESULT: f64 = 0.0;
static mut FLOAT_UNDEF: u32 = 0;
pub(crate) static mut BOUND_KEYS: [u32; 2] = [0; 2];
pub(crate) static mut FRAMES: [u32; 4] = [0; 4];
static mut CALL_BLOCK: [u32; 5] = [0; 5];
/// A callee with no probe name: CALL_BLOCK's fourth word and the call cache's probe word when ProcessInternal's gate does not apply.
pub(crate) const PROBE_NONE: u32 = 0xffff_ffff;
static mut CLASSES: [u32; 2] = [0; 2];
static mut RECEIVERS: [u32; 4] = [0; 4];
/// HANDLES = [first, old keys, old capacity, old shift]: the handle slots of
/// the tables (header).
static mut HANDLES: [u32; 4] = [0; 4];
/// js_receiver's binding set for the handle it answered (for a handle the
/// receiver table does not cover).
static mut RECEIVER_BIND: u32 = 0;
static mut CHECK: u32 = 0;
// R2b-6: VECTOR_IO, a vector or rotator js_vector/js_rotator wrote;
// RESULT3, a vector or rotator Return's value; CHECK_VALUES, the operands
// and result of a CK_OP / CK_VECTOR / CK_ROTATOR report.
static mut VECTOR_IO: [u32; 3] = [0; 3];
static mut RESULT3: [u32; 3] = [0; 3];
static mut CHECK_VALUES: [f64; 10] = [0.0; 10];
/// Script bodies begun here (`statements`, `vm_statement`): with the
/// JavaScript VM's count (script-vm.mjs scriptRunCount), a host test that no
/// script ran between two points (script-vm-render.mjs `share`).
static mut SCRIPT_RUNS: u32 = 0;

#[no_mangle]
pub extern "C" fn vm_script_runs_ptr() -> *mut u32 {
    addr_of_mut!(SCRIPT_RUNS)
}
#[no_mangle]
pub extern "C" fn vm_runaway_ptr() -> *mut u32 {
    addr_of_mut!(RUNAWAY)
}
#[no_mangle]
pub extern "C" fn vm_budget_ptr() -> *mut u32 {
    addr_of_mut!(BUDGET)
}
#[no_mangle]
pub extern "C" fn vm_result_ptr() -> *mut f64 {
    addr_of_mut!(RESULT)
}
#[no_mangle]
pub extern "C" fn vm_float_undef_ptr() -> *mut u32 {
    addr_of_mut!(FLOAT_UNDEF)
}
#[no_mangle]
pub extern "C" fn vm_bound_keys_ptr() -> *mut u32 {
    addr_of_mut!(BOUND_KEYS) as *mut u32
}
#[no_mangle]
pub extern "C" fn vm_frames_ptr() -> *mut u32 {
    addr_of_mut!(FRAMES) as *mut u32
}
#[no_mangle]
pub extern "C" fn vm_call_block_ptr() -> *mut u32 {
    addr_of_mut!(CALL_BLOCK) as *mut u32
}
#[no_mangle]
pub extern "C" fn vm_classes_ptr() -> *mut u32 {
    addr_of_mut!(CLASSES) as *mut u32
}
#[no_mangle]
pub extern "C" fn vm_handles_ptr() -> *mut u32 {
    addr_of_mut!(HANDLES) as *mut u32
}
#[no_mangle]
pub extern "C" fn vm_receivers_ptr() -> *mut u32 {
    addr_of_mut!(RECEIVERS) as *mut u32
}
#[no_mangle]
pub extern "C" fn vm_receiver_bind_ptr() -> *mut u32 {
    addr_of_mut!(RECEIVER_BIND)
}
#[no_mangle]
pub extern "C" fn vm_check_ptr() -> *mut u32 {
    addr_of_mut!(CHECK)
}
#[no_mangle]
pub extern "C" fn vm_vector_io_ptr() -> *mut u32 {
    addr_of_mut!(VECTOR_IO) as *mut u32
}
#[no_mangle]
pub extern "C" fn vm_result3_ptr() -> *mut u32 {
    addr_of_mut!(RESULT3) as *mut u32
}
#[no_mangle]
pub extern "C" fn vm_check_values_ptr() -> *mut f64 {
    addr_of_mut!(CHECK_VALUES) as *mut f64
}

/// RESULT: the value the last Return left (a body ended by a void Return holds UNDEF_F64_BITS).
#[inline(always)]
pub(crate) fn last_result() -> f64 {
    unsafe { RESULT }
}
#[inline(always)]
pub(crate) fn frames_save() -> [u32; 4] {
    unsafe { *addr_of!(FRAMES) }
}
#[inline(always)]
pub(crate) fn frames_restore(saved: [u32; 4]) {
    unsafe { *addr_of_mut!(FRAMES) = saved }
}

/// FrameStack.push (script-frame-locals.mjs): a zeroed frame block of `size`
/// bytes from the FMemStack in FRAMES; JavaScript picks or creates the next
/// chunk when this one is full. Returns the block's base.
#[no_mangle]
pub extern "C" fn vm_frame_push(size: u32) -> u32 {
    let aligned = size.wrapping_add(7) & !7;
    unsafe {
        let frames = addr_of_mut!(FRAMES) as *mut u32;
        if *frames.add(1) as u64 + aligned as u64 > *frames.add(2) as u64 {
            js_frame_advance(aligned);
        }
        let base = *frames.add(1);
        *frames.add(1) = base.wrapping_add(aligned);
        core::ptr::write_bytes(base as usize as *mut u8, 0, aligned as usize);
        base
    }
}

/// `a == b` for word arrays: every word's difference ORed, no call. Core's `==` on `[u32; N]` and `[i32; N]` is a `memcmp` call, and
/// compiler-builtins' memcmp is a byte loop: the 36-byte compare of a decal edge's table entry took 29 ns in Firefox's wasm against 8 ns
/// in V8's (docs/firefox-60fps-plan.md "Firefox wasm gap"). `--features eq_ref` builds the `==` it replaces (the A/B arm `?wordEq=ref`).
#[cfg(not(feature = "eq_ref"))]
#[inline(always)]
pub(crate) fn words_eq<const N: usize>(a: &[u32; N], b: &[u32; N]) -> bool {
    let mut diff = 0u32;
    let mut i = 0;
    while i < N {
        diff |= a[i] ^ b[i];
        i += 1;
    }
    diff == 0
}
#[cfg(feature = "eq_ref")]
#[inline(always)]
pub(crate) fn words_eq<const N: usize>(a: &[u32; N], b: &[u32; N]) -> bool {
    a == b
}
/// `words_eq` for `[i32; N]`.
#[inline(always)]
pub(crate) fn ints_eq<const N: usize>(a: &[i32; N], b: &[i32; N]) -> bool {
    #[cfg(not(feature = "eq_ref"))]
    {
        let mut diff = 0u32;
        let mut i = 0;
        while i < N {
            diff |= (a[i] ^ b[i]) as u32;
            i += 1;
        }
        diff == 0
    }
    #[cfg(feature = "eq_ref")]
    {
        a == b
    }
}

#[inline(always)]
pub(crate) fn load32(addr: u32) -> u32 {
    unsafe { read_unaligned(addr as usize as *const u32) }
}
#[inline(always)]
pub(crate) fn store32(addr: u32, value: u32) {
    unsafe { write_unaligned(addr as usize as *mut u32, value) }
}
#[inline(always)]
pub(crate) fn load8(addr: u32) -> u8 {
    unsafe { *(addr as usize as *const u8) }
}
#[inline(always)]
pub(crate) fn store8(addr: u32, value: u8) {
    unsafe { *(addr as usize as *mut u8) = value }
}
/// Math.fround.
#[inline(always)]
pub(crate) fn fround(v: f64) -> f64 {
    v as f32 as f64
}
#[inline(always)]
pub(crate) fn float_of(bits: u32) -> f64 {
    f32::from_bits(bits) as f64
}
/// The float codec's store: `Math.fround(Number(v ?? 0))`.
#[inline(always)]
pub(crate) fn float_bits(v: f64) -> u32 {
    if v.to_bits() == UNDEF_F64_BITS {
        0
    } else {
        (v as f32).to_bits()
    }
}
/// A POINTER cell's word for an object value: copyPointer's `value ?? null`
/// (UNDEFINED is None), then the handle, 0 for None.
#[inline(always)]
pub(crate) fn pointer_word(handle: u32) -> u32 {
    if handle == UNDEFINED {
        0
    } else {
        handle
    }
}
/// `r`, the double result of `x op y`, with a NaN result replaced by the
/// x87's (src/runtime/x87-nan.mjs `x87nanOf`, the original operator bodies'
/// FMUL/FDIV/FADD/FSUB, docs/script-float-vector-operators.md): a lone NaN
/// operand propagates and a NaN pair keeps the larger float32 significand,
/// the positive NaN on a tie, quieted; a NaN from non-NaN operands (inf -
/// inf, 0 * inf, 0 / 0, inf / inf) is the real indefinite 0xFFC00000. The
/// result is that float32 NaN widened, as the JavaScript helper returns it.
/// Neither the host FPU nor Rust decides: the FPU's default NaN is
/// 0x7FC00000 on arm64 and 0xFFC00000 on x86, Rust leaves a NaN result's
/// payload unspecified, and LLVM's wasm stackifier commutes f64.add/f64.mul
/// operands when the second was computed first.
#[inline(always)]
pub(crate) fn x87_nan(x: f64, y: f64, r: f64) -> f64 {
    if r.is_nan() {
        x87_nan_of(x, y)
    } else {
        r
    }
}
#[cold]
#[inline(never)]
fn x87_nan_of(x: f64, y: f64) -> f64 {
    // The float32 bits of a double NaN: its sign and the top 23 bits of its
    // payload (Math.fround and a float32 store keep these).
    let narrow = |v: f64| {
        let b = v.to_bits();
        (((b >> 32) as u32) & 0x8000_0000) | 0x7f80_0000 | ((b >> 29) as u32 & 0x7f_ffff)
    };
    let keep = match (x.is_nan(), y.is_nan()) {
        (false, false) => crate::x87::INDEFINITE,
        (true, false) => narrow(x),
        (false, true) => narrow(y),
        (true, true) => {
            let (a, b) = (narrow(x), narrow(y));
            let (sa, sb) = (a & 0x7f_ffff, b & 0x7f_ffff);
            if sa > sb || (sa == sb && a >> 31 == 0) {
                a
            } else {
                b
            }
        }
    } | 0x40_0000;
    f64::from_bits((((keep & 0x8000_0000) as u64) << 32) | 0x7ff0_0000_0000_0000 | (((keep & 0x7f_ffff) as u64) << 29))
}
/// No slot: None, or a handle at or beyond a table's window (live, not
/// entered).
pub(crate) const NO_SLOT: u32 = u32::MAX;
/// No slot: a handle below the level's first that had been released when
/// the level started.
pub(crate) const GONE: u32 = u32::MAX - 1;
/// `handle`'s slot in a table whose window is `capacity` handles (header),
/// else NO_SLOT or GONE.
#[inline(always)]
pub(crate) fn handle_slot(handle: u32, capacity: u32) -> u32 {
    let (first, old) = unsafe {
        let handles = addr_of!(HANDLES) as *const u32;
        (*handles, *handles.add(2))
    };
    let i = handle.wrapping_sub(first);
    if i < capacity {
        return old.wrapping_add(i);
    }
    if handle >= first || handle == 0 {
        return NO_SLOT;
    }
    old_slot(handle)
}
/// The slot of `handle` (nonzero, below the level's first) in the old part,
/// or GONE.
#[inline(never)]
fn old_slot(handle: u32) -> u32 {
    let (keys, capacity, shift) = unsafe {
        let handles = addr_of!(HANDLES) as *const u32;
        (*handles.add(1), *handles.add(2), *handles.add(3))
    };
    if capacity == 0 {
        return GONE;
    }
    // Never full (the host keeps it at most half full), so the probe ends.
    let mask = capacity - 1;
    let mut at = handle.wrapping_mul(0x9E37_79B1) >> shift;
    loop {
        let key = load32(keys.wrapping_add(at.wrapping_mul(4)));
        if key == handle {
            return at;
        }
        if key == 0 {
            return GONE;
        }
        at = at.wrapping_add(1) & mask;
    }
}
/// A handle's class table entry: 0, RELEASED or its class row (0 at or
/// beyond the window, where every handle is live; RELEASED for one released
/// before the level started).
#[inline(always)]
pub(crate) fn class_entry(handle: u32) -> u32 {
    let (table, capacity) = unsafe {
        let classes = addr_of!(CLASSES) as *const u32;
        (*classes, *classes.add(1))
    };
    match handle_slot(handle, capacity) {
        NO_SLOT => 0,
        GONE => RELEASED,
        slot => load32(table.wrapping_add(slot.wrapping_mul(4))),
    }
}
/// A handle's receiver info: its receiver table entry when that was entered
/// under the current epoch, else js_receiver's answer (which enters it).
#[inline(always)]
pub(crate) fn receiver_info(handle: u32) -> u32 {
    receiver(handle).0
}
/// A handle's receiver info and binding set: the address of `[length,
/// bytes...]`, one byte per field key id, nonzero for each key the object
/// itself binds (0 when it binds none, or when the host gave no set: then a
/// BOUND receiver's bound keys are the global table's). The receiver table
/// holds [info, epoch, binding set, 0] per handle slot.
pub(crate) fn receiver(handle: u32) -> (u32, u32) {
    let (table, capacity, epoch, verify) = unsafe {
        let receivers = addr_of!(RECEIVERS) as *const u32;
        (*receivers, *receivers.add(1), *receivers.add(2), *receivers.add(3))
    };
    if verify == 0 {
        let slot = handle_slot(handle, capacity);
        if slot < GONE {
            let at = table.wrapping_add(slot.wrapping_mul(16));
            if load32(at.wrapping_add(4)) == epoch {
                return (load32(at), load32(at.wrapping_add(8)));
            }
        }
    }
    let info = unsafe { js_receiver(handle) };
    (info, unsafe { RECEIVER_BIND })
}
/// A pointer cell's value as its JavaScript read yields it: a released
/// handle names no identity (identityOfHandle's null), so it is None.
#[inline(always)]
pub(crate) fn live(handle: u32) -> u32 {
    if class_entry(handle) == RELEASED {
        0
    } else {
        handle
    }
}
/// Whether class row `row` lists record id `rid`: castObject's `for (; cls;
/// cls = cls.base) if (cls.record === target)`.
#[inline(always)]
pub(crate) fn chain_has(row: u32, rid: u32) -> bool {
    let count = load32(row.wrapping_add(4));
    let mut at = row.wrapping_add(8);
    for _ in 0..count {
        if load32(at) == rid {
            return true;
        }
        at = at.wrapping_add(4);
    }
    false
}
/// FLOAT_LE's `v ?? 0`: an undefined float value is 0.
#[inline(always)]
fn undef_zero(v: f64) -> f64 {
    if v.to_bits() == UNDEF_F64_BITS {
        0.0
    } else {
        v
    }
}
/// ToInt32, as copyValue's int `Number(value) | 0` applies it to a result.
#[inline(always)]
pub(crate) fn to_int32(v: f64) -> i32 {
    if v > -2_147_483_649.0 && v < 2_147_483_648.0 {
        return v as i32;
    }
    if !v.is_finite() {
        return 0;
    }
    if v > -TWO_63 && v < TWO_63 {
        return v as i64 as i32;
    }
    // |v| >= 2^63 is an integer m * 2^e with e >= 11: its low 32 bits.
    let bits = v.to_bits();
    let e = ((bits >> 52) & 0x7ff) as i32 - 1075;
    let m = (bits & ((1 << 52) - 1)) | (1 << 52);
    let low = if e >= 32 { 0 } else { (m << e) as u32 };
    (if bits >> 63 != 0 { low.wrapping_neg() } else { low }) as i32
}
#[inline(always)]
pub(crate) fn merge_bool(word: u32, mask: u32, value: bool) -> u32 {
    if value {
        word | mask
    } else {
        word & !mask
    }
}

/// A float32 cell's value as JavaScript holds it: `getFloat32` widens, which
/// quiets a signaling NaN (an explicit bit operation: LLVM may fold a
/// widening followed by a narrowing).
#[inline(always)]
pub(crate) fn quiet(bits: u32) -> u32 {
    if bits & 0x7f80_0000 == 0x7f80_0000 && bits & 0x007f_ffff != 0 {
        bits | 0x0040_0000
    } else {
        bits
    }
}
/// A VECTOR cell read (readCell's three getFloat32).
#[inline(always)]
fn load_vector(addr: u32) -> [u32; 3] {
    [quiet(load32(addr)), quiet(load32(addr.wrapping_add(4))), quiet(load32(addr.wrapping_add(8)))]
}
/// A ROTATOR cell read (three getInt32).
#[inline(always)]
fn load_rotator(addr: u32) -> [i32; 3] {
    [load32(addr) as i32, load32(addr.wrapping_add(4)) as i32, load32(addr.wrapping_add(8)) as i32]
}
#[inline(always)]
fn store3(addr: u32, words: [u32; 3]) {
    store32(addr, words[0]);
    store32(addr.wrapping_add(4), words[1]);
    store32(addr.wrapping_add(8), words[2]);
}
#[inline(always)]
fn rotator_words(v: [i32; 3]) -> [u32; 3] {
    [v[0] as u32, v[1] as u32, v[2] as u32]
}
/// A vector component as the JavaScript number (`f32num`).
#[inline(always)]
pub(crate) fn widen(bits: u32) -> f64 {
    f32::from_bits(bits) as f64
}
/// Math.fround's float32 bits.
#[inline(always)]
fn narrow(v: f64) -> u32 {
    (v as f32).to_bits()
}
/// `Math.fround(s)` of a float operand: JavaScript's undefined (UNDEF_F64)
/// converts to NaN, V8's 0x7ff8_0000_0000_0000.
#[inline(always)]
fn fround_operand(s: f64) -> f64 {
    if s.to_bits() == UNDEF_F64_BITS {
        f64::from_bits(0x7ff8_0000_0000_0000)
    } else {
        fround(s)
    }
}
/// The x87 kernel's three-word result (lib.rs RESULT), read right after the
/// kernel body wrote it.
#[inline(always)]
fn kernel3() -> [u32; 3] {
    unsafe { *addr_of!(crate::RESULT) }
}
/// A kernel vector result as JavaScript receives it (`num` widens each word).
#[inline(always)]
fn kernel_vector() -> [u32; 3] {
    let v = kernel3();
    [quiet(v[0]), quiet(v[1]), quiet(v[2])]
}
#[inline(always)]
fn widen3(v: [u32; 3]) -> [f64; 3] {
    [widen(v[0]), widen(v[1]), widen(v[2])]
}
#[inline(always)]
fn ints3(v: [i32; 3]) -> [f64; 3] {
    [v[0] as f64, v[1] as f64, v[2] as f64]
}
/// Whether class row `row` lists name id `name` in its name list (after the
/// record ids).
#[inline(always)]
pub(crate) fn row_has_name(row: u32, name: u32) -> bool {
    let count = load32(row.wrapping_add(4));
    let mut at = row.wrapping_add(8).wrapping_add(count.wrapping_mul(4));
    for _ in 0..count {
        if load32(at) == name {
            return true;
        }
        at = at.wrapping_add(4);
    }
    false
}

/// The address of the field at `offset` with key id `key` on a receiver
/// whose info is `info`, or None when the field takes the JavaScript path
/// (a HOST receiver, or a bound key on a BOUND receiver).
#[inline(always)]
pub(crate) fn field_addr(info: u32, bind: u32, key: u32, offset: u32) -> Option<u32> {
    if info & (HOST | BOUND) != 0 {
        if info & HOST != 0 {
            return None;
        }
        if bound_key(bind, key) {
            return None;
        }
    }
    Some((info & !15).wrapping_add(offset))
}
/// Whether a BOUND receiver with binding set `bind` binds field key `key`:
/// its own set, or the global bound-key table when it has none.
#[inline(always)]
pub(crate) fn bound_key(bind: u32, key: u32) -> bool {
    let (table, length) = if bind != 0 {
        (bind.wrapping_add(4), load32(bind))
    } else {
        let keys = addr_of!(BOUND_KEYS) as *const u32;
        unsafe { (*keys, *keys.add(1)) }
    };
    key < length && load8(table.wrapping_add(key)) != 0
}

/// An expression's receiver. `handle` 0 is SELF, whose info the run caches;
/// any other handle is a context object (never None or undefined), with the
/// info fetched when that object became known.
#[derive(Clone, Copy)]
pub(crate) struct Recv {
    pub(crate) handle: u32,
    pub(crate) info: u32,
    pub(crate) bind: u32,
}
pub(crate) const SELF: Recv = Recv { handle: 0, info: 0, bind: 0 };

pub(crate) struct Run {
    pub(crate) code: *const u32,
    pub(crate) pc: *const u32,
    pub(crate) frame: u32,
    pub(crate) locals: u32,
    pub(crate) self_handle: u32,
    pub(crate) self_info: u32,
    /// SELF's binding set, fetched with self_info.
    pub(crate) self_bind: u32,
    pub(crate) self_fresh: bool,
    /// A CALL's callee: an S_YIELD statement runs through js_step here
    /// instead of returning to the host.
    pub(crate) callee: bool,
    /// The foreach this run owns (iter.rs), if any.
    pub(crate) iter: crate::iter::Iter,
}

#[cold]
#[inline(never)]
fn fail(frame: u32, code: u32, node: u32) -> ! {
    unsafe { js_error(frame, code, node) };
    core::arch::wasm32::unreachable()
}

impl Run {
    /// Operand word `i` of the node at pc.
    #[inline(always)]
    pub(crate) fn op(&self, i: usize) -> u32 {
        unsafe { *self.pc.add(i) }
    }
    #[inline(always)]
    pub(crate) fn skip(&mut self, words: usize) {
        self.pc = unsafe { self.pc.add(words) };
    }
    #[inline(always)]
    pub(crate) fn fail(&self, code: u32, node: u32) -> ! {
        fail(self.frame, code, node)
    }
    #[inline(always)]
    pub(crate) fn handle(&self, r: Recv) -> u32 {
        if r.handle == 0 {
            self.self_handle
        } else {
            r.handle
        }
    }

    // Imports. Every one except js_receiver may run JavaScript that adds
    // bindings or poison to SELF or releases it, so SELF's info goes stale.
    fn host_int(&mut self, node: u32, r: Recv) -> i32 {
        let v = unsafe { js_int(self.frame, node, self.handle(r)) };
        self.self_fresh = false;
        v
    }
    pub(crate) fn host_float(&mut self, node: u32, r: Recv) -> f64 {
        let v = unsafe { js_float(self.frame, node, self.handle(r)) };
        self.self_fresh = false;
        unsafe {
            if FLOAT_UNDEF != 0 {
                FLOAT_UNDEF = 0;
                return f64::from_bits(UNDEF_F64_BITS);
            }
        }
        v
    }
    pub(crate) fn host_bool(&mut self, node: u32, r: Recv) -> bool {
        let v = unsafe { js_bool(self.frame, node, self.handle(r)) };
        self.self_fresh = false;
        v != 0
    }
    fn host_object(&mut self, node: u32, r: Recv) -> u32 {
        let v = unsafe { js_object(self.frame, node, self.handle(r)) };
        self.self_fresh = false;
        v
    }
    fn host_eval(&mut self, node: u32, r: Recv) {
        unsafe { js_eval(self.frame, node, self.handle(r)) };
        self.self_fresh = false;
    }
    /// js_eval of `node` on a context object (gc.rs).
    pub(crate) fn host_eval_on(&mut self, node: u32, r: Recv) {
        self.host_eval(node, r);
    }
    /// The Accessed None report of a context whose object is None (gc.rs).
    pub(crate) fn accessed_none(&mut self, node: u32) {
        unsafe { js_accessed_none(self.frame, node) };
        self.self_fresh = false;
    }
    fn host_vector(&mut self, node: u32, r: Recv) -> [u32; 3] {
        unsafe { js_vector(self.frame, node, self.handle(r)) };
        self.self_fresh = false;
        unsafe { *addr_of!(VECTOR_IO) }
    }
    fn host_rotator(&mut self, node: u32, r: Recv) -> [i32; 3] {
        unsafe { js_rotator(self.frame, node, self.handle(r)) };
        self.self_fresh = false;
        let v = unsafe { *addr_of!(VECTOR_IO) };
        [v[0] as i32, v[1] as i32, v[2] as i32]
    }
    pub(crate) fn host_name(&mut self, node: u32, r: Recv) -> u32 {
        let v = unsafe { js_name(self.frame, node, self.handle(r)) };
        self.self_fresh = false;
        v
    }

    /// SCRIPT_VM_CHECK: a vector or rotator read (CK_VECTOR, CK_ROTATOR) with
    /// its value in CHECK_VALUES[6..9].
    #[inline(always)]
    fn verify3(&self, node: u32, r: Recv, kind: u32, value: [f64; 3]) {
        if unsafe { CHECK } != 0 {
            self.report(node, r, kind, [0.0; 3], [0.0; 3], value);
        }
    }
    /// SCRIPT_VM_CHECK: an operator's operands and result (CK_OP).
    #[inline(always)]
    fn verify_op(&self, node: u32, r: Recv, a: [f64; 3], b: [f64; 3], result: [f64; 3]) {
        if unsafe { CHECK } != 0 {
            self.report(node, r, CK_OP, a, b, result);
        }
    }
    #[cold]
    #[inline(never)]
    fn report(&self, node: u32, r: Recv, kind: u32, a: [f64; 3], b: [f64; 3], result: [f64; 3]) {
        unsafe {
            let values = addr_of_mut!(CHECK_VALUES) as *mut f64;
            for i in 0..3 {
                *values.add(i) = a[i];
                *values.add(3 + i) = b[i];
                *values.add(6 + i) = result[i];
            }
            js_check(self.frame, node, self.handle(r), kind, 0.0);
        }
    }

    /// SELF's receiver info, looked up again after any import other than
    /// js_receiver ran.
    #[inline(always)]
    pub(crate) fn self_info(&mut self) -> u32 {
        if !self.self_fresh {
            (self.self_info, self.self_bind) = receiver(self.self_handle);
            self.self_fresh = true;
        }
        self.self_info
    }
    /// `r`'s receiver info and binding set.
    #[inline(always)]
    pub(crate) fn recv_info(&mut self, r: Recv) -> (u32, u32) {
        if r.handle == 0 {
            let info = self.self_info();
            (info, self.self_bind)
        } else {
            (r.info, r.bind)
        }
    }

    /// The address of `r`'s field at `offset` with key id `key`, or None
    /// when the field takes the JavaScript path.
    #[inline(always)]
    pub(crate) fn field(&mut self, r: Recv, key: u32, offset: u32) -> Option<u32> {
        let (info, bind) = self.recv_info(r);
        field_addr(info, bind, key, offset)
    }

    /// SCRIPT_VM_CHECK: the host compares a value Rust computed for `node`
    /// on receiver `r` with the closure's.
    #[inline(always)]
    pub(crate) fn verify(&self, node: u32, r: Recv, kind: u32, value: f64) {
        if unsafe { CHECK } != 0 {
            unsafe { js_check(self.frame, node, self.handle(r), kind, value) };
        }
    }

    /// castObject(value, target, 'dynamic') for the evaluated value (a
    /// handle, UNDEFINED for a JavaScript undefined); `rid` is the target's
    /// record id, 0 for a None target.
    fn cast(&mut self, value: u32, rid: u32, node: u32) -> u32 {
        // `value == null`: None or undefined.
        if value == 0 || value == UNDEFINED {
            return 0;
        }
        let result = if rid == 0 {
            // A None target: a dynamic cast is the value.
            value
        } else {
            let mut row = class_entry(value);
            if row == 0 {
                // js_class_row runs no script: it describes an attached
                // instance's class, or returns 0.
                row = unsafe { js_class_row(value) };
            }
            if row <= RELEASED {
                // Not described (or a released SELF handle, which the
                // closure casts as `fr.instance`): castObject in JavaScript.
                let result = unsafe { js_cast(self.frame, node, value) };
                self.self_fresh = false;
                return result;
            }
            if chain_has(row, rid) {
                value
            } else {
                0
            }
        };
        if unsafe { CHECK } != 0 {
            unsafe { js_check(self.frame, node, value, CK_CAST, result as f64) };
        }
        result
    }

    /// The address of the property at `offset` in the class default image of
    /// `r`'s class (defaultReference -> classDefaultReference), or None when
    /// the JavaScript path must evaluate the node: a HOST receiver (not
    /// attached here, released, a class), a handle the host does not
    /// describe, a default image that cannot be read here, or a class whose
    /// chain lacks `owner` (the property is not in its PropertyLink).
    #[inline(always)]
    fn default_addr(&mut self, r: Recv, owner: u32, offset: u32) -> Option<u32> {
        let info = if r.handle == 0 { self.self_info() } else { r.info };
        if info & HOST != 0 {
            return None;
        }
        let handle = self.handle(r);
        let mut row = class_entry(handle);
        if row <= RELEASED {
            row = unsafe { js_class_row(handle) };
            if row == 0 {
                return None;
            }
        }
        let mut image = load32(row);
        if image == 0 {
            // A class default or image changed: the host validates the
            // row's image again.
            unsafe { js_class_row(handle) };
            image = load32(row);
        }
        if image <= UNREADABLE || !chain_has(row, owner) {
            return None;
        }
        Some(image.wrapping_add(offset))
    }

    /// A FIELD_ELEM_* or LOCAL_ELEM_* node (header): its element address,
    /// None when `node` takes the JavaScript path, then `node` and the bool
    /// mask.
    #[inline(always)]
    fn element(&mut self, r: Recv, kind: u32) -> (Option<u32>, u32, u32) {
        let (offset, stride, dim, node) = (self.op(1), self.op(2), self.op(3), self.op(4));
        let field = kind <= FIELD_ELEM_OBJECT;
        let mut words = 5;
        let key = if field {
            words += 1;
            self.op(5)
        } else {
            0
        };
        let mask = if kind == FIELD_ELEM_BOOL || kind == LOCAL_ELEM_BOOL {
            words += 1;
            self.op(words - 1)
        } else {
            0
        };
        self.skip(words);
        // compileEv 0x1a: arrayReference(left.rv(fr, fr.instance), right.ev(fr,
        // r)): the index first, with SELF.
        let index = self.int(SELF) as u32;
        let base = if field { self.field(r, key, offset) } else { Some(self.locals.wrapping_add(offset)) };
        match base {
            Some(base) if index < dim => (Some(base.wrapping_add(index.wrapping_mul(stride))), node, mask),
            _ => (None, node, mask),
        }
    }

    /// Core's GRunaway count for a jump, before its condition is evaluated.
    #[inline(always)]
    fn runaway(&self) {
        unsafe {
            let count = RUNAWAY.wrapping_add(1);
            RUNAWAY = count;
            if count > RUNAWAY_LIMIT {
                RUNAWAY = 0;
                self.fail(ERR_RUNAWAY, 0);
            }
        }
    }

    /// resumeCompiled's loop. Returns -1 after a Return (its value in
    /// RESULT) or the index of an S_YIELD statement, which the JavaScript
    /// loop executes (and counts) before re-entering.
    pub(crate) fn statements(&mut self, entry: u32) -> i32 {
        unsafe { SCRIPT_RUNS = SCRIPT_RUNS.wrapping_add(1) };
        let code = self.code;
        let count = unsafe { *code };
        let mut cursor = entry;
        // The actor list a CycleActors start found ready (iter.rs foreach_ready), for the statement that follows.
        let mut list = 0;
        loop {
            // NEXT_NONE (u32::MAX) is never below the count.
            let inside = cursor < count;
            if inside {
                self.pc = unsafe { code.add(*code.add(1 + 2 * cursor as usize) as usize) };
                // A foreach start Rust cannot own here (iter.rs) is an S_YIELD: the JavaScript loop starts the iterator.
                let kind = self.op(0);
                if kind == S_FOREACH_CYCLE {
                    list = self.foreach_ready();
                }
                if kind == S_YIELD || (kind == S_FOREACH_CYCLE && list == 0) {
                    if !self.callee {
                        return cursor as i32;
                    }
                    // The callee's statement runs in JavaScript: one step of
                    // its compiled loop, counted as the loop counts it.
                    unsafe {
                        if BUDGET == 0 {
                            self.fail(ERR_HANG, 0);
                        }
                        BUDGET -= 1;
                    }
                    let next = unsafe { js_step(self.frame, cursor) };
                    self.self_fresh = false;
                    if next == RETURNED {
                        return -1;
                    }
                    cursor = next;
                    continue;
                }
            }
            // `if (!budget--)` precedes the instruction lookup in JavaScript.
            unsafe {
                if BUDGET == 0 {
                    self.fail(ERR_HANG, 0);
                }
                BUDGET -= 1;
            }
            if !inside {
                self.fail(ERR_OUTSIDE, 0);
            }
            cursor = unsafe { *code.add(2 + 2 * cursor as usize) };
            let kind = self.op(0);
            match kind {
                S_EXPR => {
                    self.skip(1);
                    self.effect();
                }
                S_JUMP => {
                    let target = self.op(1);
                    self.runaway();
                    cursor = target;
                }
                S_JUMP_IF_NOT => {
                    let target = self.op(1);
                    self.skip(2);
                    self.runaway();
                    if !self.boolean(SELF) {
                        cursor = target;
                    }
                }
                S_RETURN | S_RETURN_ITER => {
                    // stepCompiled: `if (frame.iterators.length) throw`
                    // before the value (a body with a foreach).
                    if kind == S_RETURN_ITER && (self.iter.active || unsafe { js_iterators(self.frame) } != 0) {
                        self.fail(ERR_RETURN_ITERATOR, 0);
                    }
                    let rkind = self.op(1);
                    self.skip(2);
                    let value = match rkind {
                        // A void Return: RESULT holds undefined, never a
                        // nested run's leftover value.
                        R_VOID => f64::from_bits(UNDEF_F64_BITS),
                        R_INT => self.int(SELF) as f64,
                        R_BOOL => self.boolean(SELF) as i32 as f64,
                        R_FLOAT => self.float(SELF),
                        R_OBJECT => self.object(SELF) as f64,
                        // The host builds the Array from RESULT3.
                        R_VECTOR => {
                            let v = self.vector(SELF);
                            unsafe { *addr_of_mut!(RESULT3) = v };
                            0.0
                        }
                        R_ROTATOR => {
                            let v = self.rotator(SELF);
                            unsafe { *addr_of_mut!(RESULT3) = rotator_words(v) };
                            0.0
                        }
                        _ => self.fail(ERR_KIND, rkind),
                    };
                    unsafe { RESULT = value };
                    return -1;
                }
                S_NOTHING => {}
                S_FOREACH_CYCLE => cursor = self.foreach_start(cursor, list),
                S_ITER_NEXT => {
                    if self.iter.active {
                        cursor = self.foreach_next();
                    } else {
                        cursor = unsafe { js_iterator_next(self.frame) };
                        self.self_fresh = false;
                    }
                }
                S_ITER_POP => {
                    if self.iter.active {
                        self.iter.active = false;
                    } else {
                        unsafe { js_iterator_pop(self.frame) };
                        self.self_fresh = false;
                    }
                }
                _ => self.fail(ERR_KIND, kind),
            }
        }
    }

    /// Statement `index` of a state frame, for the host's loop, which has
    /// counted the budget and advanced the cursor (stepCompiled's cases):
    /// 1 when a jump is taken, else 0.
    fn statement(&mut self, index: u32) -> i32 {
        let code = self.code;
        if index >= unsafe { *code } {
            self.fail(ERR_OUTSIDE, 0);
        }
        self.pc = unsafe { code.add(*code.add(1 + 2 * index as usize) as usize) };
        let kind = self.op(0);
        match kind {
            S_EXPR => {
                self.skip(1);
                self.effect();
                0
            }
            // `if (++scriptRunaway > limit)` precedes the condition.
            S_JUMP => {
                self.runaway();
                1
            }
            S_JUMP_IF_NOT => {
                self.skip(2);
                self.runaway();
                if self.boolean(SELF) {
                    0
                } else {
                    1
                }
            }
            S_NOTHING => 0,
            _ => self.fail(ERR_KIND, kind),
        }
    }

    /// A statement expression, evaluated for its effect.
    fn effect(&mut self) {
        let kind = self.op(0);
        match kind {
            JS_VOID => {
                let node = self.op(1);
                self.skip(2);
                self.host_eval(node, SELF);
            }
            SET_LOCAL_INT => {
                let addr = self.locals.wrapping_add(self.op(1));
                self.skip(2);
                let v = self.int(SELF);
                store32(addr, v as u32);
            }
            SET_LOCAL_BYTE => {
                let addr = self.locals.wrapping_add(self.op(1));
                self.skip(2);
                let v = self.int(SELF);
                store8(addr, v as u8);
            }
            SET_LOCAL_BOOL => {
                let addr = self.locals.wrapping_add(self.op(1));
                let mask = self.op(2);
                self.skip(3);
                let v = self.boolean(SELF);
                store32(addr, merge_bool(load32(addr), mask, v));
            }
            SET_LOCAL_FLOAT => {
                let addr = self.locals.wrapping_add(self.op(1));
                self.skip(2);
                let v = self.float(SELF);
                store32(addr, float_bits(v));
            }
            SET_LOCAL_OBJECT => {
                let addr = self.locals.wrapping_add(self.op(1));
                self.skip(2);
                let v = self.object(SELF);
                store32(addr, pointer_word(v));
            }
            SET_FIELD_INT | SET_FIELD_BYTE | SET_FIELD_BOOL | SET_FIELD_FLOAT | SET_FIELD_OBJECT | SET_FIELD_VECTOR
            | SET_FIELD_ROTATOR => self.set_field(kind),
            SET_LOCAL_VECTOR => {
                // assignLocalOf: the codec copy of a vector is its float32
                // components, stored by setFloat32.
                let addr = self.locals.wrapping_add(self.op(1));
                self.skip(2);
                let v = self.vector(SELF);
                store3(addr, v);
            }
            SET_LOCAL_ROTATOR => {
                let addr = self.locals.wrapping_add(self.op(1));
                self.skip(2);
                let v = self.rotator(SELF);
                store3(addr, rotator_words(v));
            }
            // `a[i] = V` / `a[i].m = V` on a local fixed array (or a struct local's array member): `kind, off, stride, dim, node, check,
            // len` (`off` includes the member's offset; `node` the whole Let, `check` the target), then the index, then `len` words
            // of value. compileAssign's generic path: the target's reference first (arrayReference: the index, evaluated with SELF), then
            // the value, then the store of its codec copy. An index outside [0, dim) (arrayReference's warning and clamp) runs the Let
            // in JavaScript, the value unevaluated here. The store writes the element's bytes only; JavaScript's member reference
            // writes the whole struct back (differing in another member's signaling NaN, or an object handle already released).
            SET_LOCAL_ELEM => {
                let (sub, offset, stride, dim) = (self.op(1), self.op(2), self.op(3), self.op(4));
                let (node, check, length) = (self.op(5), self.op(6), self.op(7) as usize);
                self.skip(8);
                let index = self.int(SELF) as u32;
                if index >= dim {
                    self.skip(length);
                    self.host_eval(node, SELF);
                    return;
                }
                let addr = self.locals.wrapping_add(offset).wrapping_add(index.wrapping_mul(stride));
                match sub {
                    E_INT => {
                        let v = self.int(SELF);
                        store32(addr, v as u32);
                    }
                    E_BYTE => {
                        let v = self.int(SELF);
                        store8(addr, v as u8);
                    }
                    E_FLOAT => {
                        let v = self.float(SELF);
                        store32(addr, float_bits(v));
                    }
                    E_OBJECT => {
                        let v = self.object(SELF);
                        store32(addr, pointer_word(v));
                    }
                    E_VECTOR => {
                        let v = self.vector(SELF);
                        store3(addr, v);
                    }
                    _ => self.fail(ERR_KIND, sub),
                }
                // CHECK / STRUCT_ARRAYS=verify: the element read back through the target's closure
                if unsafe { CHECK } != 0 || crate::iter::feature(2) {
                    match sub {
                        E_INT => unsafe { js_check(self.frame, check, self.handle(SELF), CK_INT, load32(addr) as i32 as f64) },
                        E_BYTE => unsafe { js_check(self.frame, check, self.handle(SELF), CK_INT, load8(addr) as f64) },
                        E_FLOAT => unsafe { js_check(self.frame, check, self.handle(SELF), CK_FLOAT, float_of(load32(addr))) },
                        E_OBJECT => unsafe { js_check(self.frame, check, self.handle(SELF), CK_OBJECT, live(load32(addr)) as f64) },
                        _ => self.report(check, SELF, CK_VECTOR, [0.0; 3], [0.0; 3], widen3(load_vector(addr))),
                    }
                    self.self_fresh = false;
                }
            }
            SET_ROTATION => self.set_rotation(),
            VCOMPOUND_LOCAL => {
                let (op, node) = (self.op(1), self.op(3));
                let addr = self.locals.wrapping_add(self.op(2));
                if op.wrapping_sub(V_MUL_FLOAT) > R_SUB - V_MUL_FLOAT {
                    self.fail(ERR_KIND, op);
                }
                self.skip(4);
                self.vcompound(op, addr, node);
            }
            VCOMPOUND_FIELD => {
                let (op, offset, node, key) = (self.op(1), self.op(2), self.op(3), self.op(4));
                let length = self.op(5) as usize;
                if op.wrapping_sub(V_MUL_FLOAT) > R_SUB - V_MUL_FLOAT {
                    self.fail(ERR_KIND, op);
                }
                self.skip(6);
                let Some(addr) = self.field(SELF, key, offset) else {
                    // The JavaScript path runs the whole out-native call.
                    self.skip(length);
                    self.host_eval(node, SELF);
                    return;
                };
                self.vcompound(op, addr, node);
            }
            COMPOUND_LOCAL => {
                let op = self.op(1);
                let addr = self.locals.wrapping_add(self.op(2));
                if op.wrapping_sub(C_FLOAT_ADD) > C_INT_SUB - C_FLOAT_ADD {
                    self.fail(ERR_KIND, op);
                }
                self.skip(3);
                self.compound(op, addr);
            }
            COMPOUND_FIELD => {
                let (op, offset, node, key) = (self.op(1), self.op(2), self.op(3), self.op(4));
                let length = self.op(5) as usize;
                if op.wrapping_sub(C_FLOAT_ADD) > C_INT_SUB - C_FLOAT_ADD {
                    self.fail(ERR_KIND, op);
                }
                self.skip(6);
                let Some(addr) = self.field(SELF, key, offset) else {
                    // The JavaScript path runs the whole out-native call.
                    self.skip(length);
                    self.host_eval(node, SELF);
                    return;
                };
                self.compound(op, addr);
            }
            INC_LOCAL_PRE | DEC_LOCAL_PRE | INC_LOCAL_POST => {
                self.int(SELF);
            }
            CALL | CALL_OUT => {
                self.call(SELF);
            }
            crate::gc::GC_EFFECT => self.gc_effect(),
            _ => self.fail(ERR_KIND, kind),
        }
    }

    /// A script call (compileCall -> runtime.invoke -> callFunction ->
    /// executeScript) on receiver `r`. The value is in f64 form by the
    /// call's rkind: int as f64, bool 0/1, float, object handle; 0 for void.
    fn call(&mut self, r: Recv) -> f64 {
        let with_out = self.op(0) == CALL_OUT;
        let (node, rkind, sig, argc) = (self.op(1), self.op(2), self.op(3), self.op(4));
        let args_len = self.op(5) as usize;
        if rkind > R_OBJECT {
            self.fail(ERR_KIND, rkind);
        }
        // CALL_OUT: the sources of its struct out arguments (iter.rs).
        let sources = if with_out { self.out_sources() } else { crate::iter::NO_SOURCES };
        if !with_out {
            self.skip(6);
        }
        let receiver = self.handle(r);
        // CallFunction's FMemMark: the frame stack as it was before the push.
        let saved = frames_save();
        // The callee's run id, frame block, code and SELF: from the call
        // cache (dispatch.rs), or js_call_begin and CALL_BLOCK. A struct out
        // argument whose source the image cannot address leaves the whole call
        // to JavaScript, before anything is pushed or evaluated.
        let (callee, locals, code, callee_self, probe, destroy) = if with_out && !self.out_addressable(&sources) {
            (-1, 0, 0, 0, PROBE_NONE, 0)
        } else {
            match crate::dispatch::begin_call(self.frame, self.code as usize as u32, node, receiver, sig) {
                Some(c) => (c.id as i32, c.locals, c.code, receiver, c.probe, c.destroy),
                None => {
                    let callee = unsafe { js_call_begin(self.frame, node, receiver, sig) };
                    self.self_fresh = false;
                    // The callee block is read before any argument runs a
                    // nested call.
                    let block = addr_of!(CALL_BLOCK) as *const u32;
                    unsafe { (callee, *block, *block.add(1), *block.add(2), *block.add(3), *block.add(4)) }
                }
            }
        };
        if callee < 0 {
            // The JavaScript path performs the whole call, arguments included.
            self.skip(args_len);
            let value = match rkind {
                R_VOID => {
                    self.host_eval(node, r);
                    0.0
                }
                R_INT => self.host_int(node, r) as f64,
                R_BOOL => self.host_bool(node, r) as i32 as f64,
                R_FLOAT => self.host_float(node, r),
                _ => self.host_object(node, r) as f64,
            };
            frames_restore(saved);
            return value;
        }
        // Parameters in order, each stored before the next is evaluated; the
        // arguments evaluate in the caller's run with the caller's SELF.
        let mut outs = crate::iter::NO_OUTS;
        for _ in 0..argc {
            let (pkind, offset, mask) = (self.op(0), self.op(1), self.op(2));
            self.skip(3);
            let addr = locals.wrapping_add(offset);
            match pkind {
                P_SKIP => {}
                // A struct out parameter: copied in from its source now, back out after the callee (iter.rs).
                P_STRUCT => self.out_struct_in(&sources, mask, addr, node, &mut outs, true),
                // A struct by value: copied in now, nothing copied back.
                P_STRUCT_IN => self.out_struct_in(&sources, mask, addr, node, &mut outs, false),
                // A vector or rotator argument: stored as SET_LOCAL_VECTOR / SET_LOCAL_ROTATOR store theirs.
                P_VECTOR => {
                    let v = self.vector(SELF);
                    store3(addr, v);
                }
                P_ROTATOR => {
                    let v = self.rotator(SELF);
                    store3(addr, rotator_words(v));
                }
                P_INT => {
                    let v = self.int(SELF);
                    store32(addr, v as u32);
                }
                P_BYTE => {
                    let v = self.int(SELF);
                    store8(addr, v as u8);
                }
                P_BOOL => {
                    let v = self.boolean(SELF);
                    store32(addr, merge_bool(load32(addr), mask, v));
                }
                P_FLOAT => {
                    let v = self.float(SELF);
                    store32(addr, float_bits(v));
                }
                P_OBJECT => {
                    let v = self.object(SELF);
                    store32(addr, pointer_word(v));
                }
                _ => self.fail(ERR_KIND, pkind),
            }
        }
        // UObject::ProcessInternal (Core 0x1013f6c6-0x1013f6fe): a probe-named function does not run when its object's StateFrame
        // ProbeMask lacks the name's bit, whoever called it; the arguments are evaluated above, the frame is put back below.
        if probe != PROBE_NONE && !crate::natives::probing_name(callee_self, probe) {
            // (callFunction still copies the out parameters back)
            self.out_struct_back(&outs, node);
            frames_restore(saved);
            self.self_fresh = false;
            return 0.0;
        }
        // executeScript: the callee's own resumeCompiled budget.
        let caller_budget = unsafe { BUDGET };
        unsafe { BUDGET = HANG_BUDGET };
        let code = code as usize as *const u32;
        let mut run = Run {
            code,
            pc: code,
            frame: callee as u32,
            locals,
            self_handle: callee_self,
            self_info: 0,
            self_bind: 0,
            self_fresh: false,
            callee: true,
            iter: crate::iter::NO_ITER,
        };
        run.statements(0);
        unsafe { BUDGET = caller_budget };
        // callFunction copies the out parameters back, last first, after the result is taken.
        self.out_struct_back(&outs, node);
        // ... then destroys the frame's locals that need it (the block is still live).
        if destroy != 0 {
            unsafe { js_run_end(callee as u32, destroy) };
            self.self_fresh = false;
        }
        frames_restore(saved);
        self.self_fresh = false;
        // callFunction's copyValue(fn.result, value): undefined is the zero.
        let result = unsafe { RESULT };
        if result.to_bits() == UNDEF_F64_BITS {
            return 0.0;
        }
        match rkind {
            R_INT => to_int32(result) as f64,
            R_BOOL => (result != 0.0 && !result.is_nan()) as i32 as f64,
            R_FLOAT => fround(result),
            R_OBJECT => {
                let handle = result as u32;
                (if handle == UNDEFINED { 0 } else { handle }) as f64
            }
            _ => 0.0,
        }
    }

    /// assignFieldOf on SELF: the storage is selected before the value is
    /// evaluated; a field on the JavaScript path runs the whole original Let
    /// node there instead, and its lowered value is skipped unevaluated.
    fn set_field(&mut self, kind: u32) {
        let offset = self.op(1);
        let node = self.op(2);
        let key = self.op(3);
        let length = self.op(4) as usize;
        let mask = if kind == SET_FIELD_BOOL { self.op(5) } else { 0 };
        self.skip(if kind == SET_FIELD_BOOL { 6 } else { 5 });
        let Some(addr) = self.field(SELF, key, offset) else {
            self.skip(length);
            self.host_eval(node, SELF);
            return;
        };
        match kind {
            SET_FIELD_INT => {
                let v = self.int(SELF);
                store32(addr, v as u32);
            }
            SET_FIELD_BYTE => {
                let v = self.int(SELF);
                store8(addr, v as u8);
            }
            SET_FIELD_BOOL => {
                let v = self.boolean(SELF);
                store32(addr, merge_bool(load32(addr), mask, v));
            }
            SET_FIELD_FLOAT => {
                let v = self.float(SELF);
                store32(addr, float_bits(v));
            }
            SET_FIELD_VECTOR => {
                let v = self.vector(SELF);
                store3(addr, v);
            }
            SET_FIELD_ROTATOR => {
                let v = self.rotator(SELF);
                store3(addr, rotator_words(v));
            }
            _ => {
                let v = self.object(SELF);
                store32(addr, pointer_word(v));
            }
        }
    }

    /// SET_ROTATION 211 `ctx, node, has_ctx, bStatic (off, key, mask), bMovable (off, key, mask), Rotation (off, key), Brush (off, key),
    /// StandingCount (off, key), len`, the context object's code (when `has_ctx`), then the rotator's `len` words: script-set-rotation.mjs
    /// setScriptRotation, ULevel::MoveActor with a zero Delta on a non-editor level (docs/script-set-rotation.md). The context object comes
    /// first, evaluated with SELF (None: Accessed None at `ctx`, the rotator unevaluated); a receiver whose five fields the image does not
    /// all answer for runs the native node in JavaScript before the rotator is evaluated. Then: a static or immovable actor is left alone
    /// (MoveActor returns false), so is one whose Rotation already equals the requested ints, one with a Brush or a nonzero StandingCount
    /// (riders) runs the native in JavaScript (the rotator is a read without imports, evaluated again there), and any other stores the three
    /// ints at Rotation. FEATURES word 3 (SET_ROTATION=verify) has the host decide the same from readNamed first (js_set_rotation_check).
    fn set_rotation(&mut self) {
        let (ctx, node, has_ctx) = (self.op(1), self.op(2), self.op(3) != 0);
        let (s_off, s_key, s_mask) = (self.op(4), self.op(5), self.op(6));
        let (m_off, m_key, m_mask) = (self.op(7), self.op(8), self.op(9));
        let (r_off, r_key, b_off, b_key, c_off, c_key) = (self.op(10), self.op(11), self.op(12), self.op(13), self.op(14), self.op(15));
        let length = self.op(16) as usize;
        self.skip(17);
        let r = if has_ctx {
            let object = self.object(SELF);
            if object == 0 || object == UNDEFINED {
                self.skip(length);
                self.accessed_none(ctx);
                return;
            }
            let (info, bind) = receiver(object);
            Recv { handle: object, info, bind }
        } else {
            SELF
        };
        let addresses = (self.field(r, s_key, s_off), self.field(r, m_key, m_off), self.field(r, r_key, r_off), self.field(r, b_key, b_off), self.field(r, c_key, c_off));
        let (Some(stat), Some(movable), Some(rotation), Some(brush), Some(standing)) = addresses else {
            self.skip(length);
            self.set_rotation_native(node, r, has_ctx);
            return;
        };
        let want = self.rotator(SELF);
        // 0 left alone (static or immovable), 1 unchanged, 2 riders or a Brush (JavaScript), 3 stored
        let decision = if load32(stat) & s_mask != 0 || load32(movable) & m_mask == 0 {
            0
        } else if ints_eq(&load_rotator(rotation), &want) {
            1
        } else if live(load32(brush)) != 0 || load8(standing) != 0 {
            2
        } else {
            3
        };
        if crate::iter::feature(3) {
            unsafe { js_set_rotation_check(self.frame, node, self.handle(r), decision, want[0] as u32, want[1] as u32, want[2] as u32) };
            self.self_fresh = false;
        }
        match decision {
            2 => self.set_rotation_native(node, r, has_ctx),
            3 => store3(rotation, rotator_words(want)),
            _ => {}
        }
    }
    fn set_rotation_native(&mut self, node: u32, r: Recv, has_ctx: bool) {
        if has_ctx {
            self.host_eval_on(node, r);
        } else {
            self.host_eval(node, SELF);
        }
    }

    /// An out vector or rotator native as a statement, `X op= V`, through
    /// storage `addr` already selected: V (argument 1) is evaluated with
    /// SELF, then native() reads X (`args.map(refValue)`), computes, and
    /// `assign(args[0], out)` stores the codec copy (the same words).
    fn vcompound(&mut self, op: u32, addr: u32, node: u32) {
        match op {
            V_MUL_FLOAT | V_DIV_FLOAT => {
                let s = self.float(SELF);
                let a = load_vector(addr);
                let b = narrow(fround_operand(s));
                // 221 / 222: the kernel bodies.
                if op == V_MUL_FLOAT {
                    crate::op_multiply_equal_vector_float(a[0], a[1], a[2], b);
                } else {
                    crate::op_divide_equal_vector_float(a[0], a[1], a[2], b);
                }
                let v = kernel_vector();
                self.verify_op(node, SELF, widen3(a), [s, 0.0, 0.0], widen3(v));
                store3(addr, v);
            }
            V_ADD | V_SUB | V_MUL => {
                let b = self.vector(SELF);
                let a = load_vector(addr);
                let v = match op {
                    // 223: a.map((v, i) => f(f(v) + f(b[i]))).
                    V_ADD => {
                        let (x, y) = (widen3(a), widen3(b));
                        [
                            narrow(x87_nan(x[0], y[0], x[0] + y[0])),
                            narrow(x87_nan(x[1], y[1], x[1] + y[1])),
                            narrow(x87_nan(x[2], y[2], x[2] + y[2])),
                        ]
                    }
                    // 224 / 297: the kernel bodies.
                    V_SUB => {
                        crate::op_subtract_equal_vector_vector(a[0], a[1], a[2], b[0], b[1], b[2]);
                        kernel_vector()
                    }
                    _ => {
                        crate::op_multiply_equal_vector_vector(a[0], a[1], a[2], b[0], b[1], b[2]);
                        kernel_vector()
                    }
                };
                self.verify_op(node, SELF, widen3(a), widen3(b), widen3(v));
                store3(addr, v);
            }
            R_ADD | R_SUB => {
                // 318/319: ((v|0) ± (b[i]|0)) | 0 per word.
                let b = self.rotator(SELF);
                let a = load_rotator(addr);
                let v = if op == R_ADD {
                    [a[0].wrapping_add(b[0]), a[1].wrapping_add(b[1]), a[2].wrapping_add(b[2])]
                } else {
                    [a[0].wrapping_sub(b[0]), a[1].wrapping_sub(b[1]), a[2].wrapping_sub(b[2])]
                };
                self.verify_op(node, SELF, ints3(a), ints3(b), ints3(v));
                store3(addr, rotator_words(v));
            }
            _ => self.fail(ERR_KIND, op),
        }
    }

    /// `X op= V` through storage `addr` already selected (compileNative's
    /// reference argument 0): V (argument 1) is evaluated with SELF, then
    /// the native reads X, computes and stores through the reference, whose
    /// set runs the float codec (`Math.fround(Number(v ?? 0))`) or the int
    /// codec (`Number(v) | 0`). A float V that is UNDEF_F64 is JavaScript's
    /// undefined, which `a + undefined` and `f(undefined)` convert to NaN:
    /// it enters the arithmetic as that NaN, never as the store's `?? 0`.
    fn compound(&mut self, op: u32, addr: u32) {
        match op {
            C_FLOAT_ADD | C_FLOAT_SUB | C_FLOAT_MUL => {
                let b = self.float(SELF);
                // ToNumber(undefined): the NaN JavaScript computes with.
                let b = if b.to_bits() == UNDEF_F64_BITS { f64::NAN } else { b };
                let a = float_of(load32(addr));
                let v = match op {
                    // 184: assign(args[0], f(a + b))
                    C_FLOAT_ADD => fround(x87_nan(a, b, a + b)),
                    // 185: assign(args[0], f(f(a) - f(b)))
                    C_FLOAT_SUB => {
                        let (x, y) = (fround(a), fround(b));
                        fround(x87_nan(x, y, x - y))
                    }
                    // 182: assign(args[0], f(a * b))
                    _ => fround(x87_nan(a, b, a * b)),
                };
                store32(addr, float_bits(v));
            }
            C_INT_ADD | C_INT_SUB => {
                let b = self.int(SELF);
                let a = load32(addr) as i32;
                // 161/162: ((a|0) ± (b|0)) | 0, then args[0].set(result).
                let v = if op == C_INT_ADD { a.wrapping_add(b) } else { a.wrapping_sub(b) };
                store32(addr, v as u32);
            }
            _ => self.fail(ERR_KIND, op),
        }
    }

    /// `Object.Value`: the object is evaluated with the current receiver.
    /// None or undefined reports Accessed None, skips the value and yields
    /// None; otherwise the value is evaluated with the object as receiver.
    #[inline(always)]
    fn context(&mut self, r: Recv) -> Option<Recv> {
        let node = self.op(1);
        let length = self.op(2) as usize;
        self.skip(3);
        let object = self.object(r);
        if object == 0 || object == UNDEFINED {
            self.skip(length);
            unsafe { js_accessed_none(self.frame, node) };
            self.self_fresh = false;
            return None;
        }
        let (info, bind) = receiver(object);
        Some(Recv { handle: object, info, bind })
    }

    /// A vector value (R2b-6): three quiet float32 bit patterns.
    fn vector(&mut self, r: Recv) -> [u32; 3] {
        let kind = self.op(0);
        match kind {
            LIT_VECTOR => {
                let v = [self.op(1), self.op(2), self.op(3)];
                self.skip(4);
                v
            }
            LOCAL_VECTOR => {
                let (offset, node) = (self.op(1), self.op(2));
                self.skip(3);
                let v = load_vector(self.locals.wrapping_add(offset));
                self.verify3(node, r, CK_VECTOR, widen3(v));
                v
            }
            FIELD_VECTOR => {
                let (offset, node, key) = (self.op(1), self.op(2), self.op(3));
                self.skip(4);
                match self.field(r, key, offset) {
                    Some(addr) => {
                        let v = load_vector(addr);
                        self.verify3(node, r, CK_VECTOR, widen3(v));
                        v
                    }
                    None => self.host_vector(node, r),
                }
            }
            // A vector element of a local fixed array, or a vector member of an element of a struct local's array (`off` includes
            // the member's offset): compileEv 0x1a / 0x36 as LOCAL_ELEM_* read a scalar one. The index first, with SELF; an index
            // outside [0, dim) takes the closure (arrayReference's warning and clamp).
            LOCAL_ELEM_VECTOR => {
                let (offset, stride, dim, node) = (self.op(1), self.op(2), self.op(3), self.op(4));
                self.skip(5);
                let index = self.int(SELF) as u32;
                if index >= dim {
                    return self.host_vector(node, r);
                }
                let v = load_vector(self.locals.wrapping_add(offset).wrapping_add(index.wrapping_mul(stride)));
                self.verify3(node, r, CK_VECTOR, widen3(v));
                v
            }
            JS_VECTOR => {
                let node = self.op(1);
                self.skip(2);
                self.host_vector(node, r)
            }
            CONTEXT => match self.context(r) {
                Some(object) => self.vector(object),
                None => [0; 3],
            },
            VECTOR_ADD | VECTOR_SUB | VECTOR_MUL | VECTOR_MIRROR => {
                let node = self.op(1);
                self.skip(2);
                let a = self.vector(SELF);
                let b = self.vector(SELF);
                let (x, y) = (widen3(a), widen3(b));
                let v = match kind {
                    // 215/216: a.map((v, i) => f(v op b[i])).
                    VECTOR_ADD => [
                        narrow(x87_nan(x[0], y[0], x[0] + y[0])),
                        narrow(x87_nan(x[1], y[1], x[1] + y[1])),
                        narrow(x87_nan(x[2], y[2], x[2] + y[2])),
                    ],
                    VECTOR_SUB => [
                        narrow(x87_nan(x[0], y[0], x[0] - y[0])),
                        narrow(x87_nan(x[1], y[1], x[1] - y[1])),
                        narrow(x87_nan(x[2], y[2], x[2] - y[2])),
                    ],
                    // 296 / 300: the x87 kernel bodies.
                    VECTOR_MUL => {
                        crate::op_multiply_vector_vector(a[0], a[1], a[2], b[0], b[1], b[2]);
                        kernel_vector()
                    }
                    _ => {
                        crate::op_mirror_vector_by_normal(a[0], a[1], a[2], b[0], b[1], b[2]);
                        kernel_vector()
                    }
                };
                self.verify_op(node, r, x, y, widen3(v));
                v
            }
            VECTOR_SCALE | VECTOR_DIVIDE => {
                let node = self.op(1);
                self.skip(2);
                let a = self.vector(SELF);
                let s = self.float(SELF);
                let x = widen3(a);
                let fs = fround_operand(s);
                let v = if kind == VECTOR_SCALE {
                    // 212: a.map(v => f(f(v) * f(b))).
                    [
                        narrow(x87_nan(x[0], fs, x[0] * fs)),
                        narrow(x87_nan(x[1], fs, x[1] * fs)),
                        narrow(x87_nan(x[2], fs, x[2] * fs)),
                    ]
                } else {
                    // 214: the kernel's DivideEqual_VectorFloat body (the
                    // JavaScript VM's case 214), whose 80-bit reciprocal
                    // the original keeps on the x87 stack.
                    crate::op_divide_equal_vector_float(a[0], a[1], a[2], narrow(fs));
                    kernel_vector()
                };
                self.verify_op(node, r, x, [s, 0.0, 0.0], widen3(v));
                v
            }
            SCALE_VECTOR => {
                // 213: b.map(v => f(f(a) * f(v))).
                let node = self.op(1);
                self.skip(2);
                let s = self.float(SELF);
                let b = self.vector(SELF);
                let y = widen3(b);
                let fs = fround_operand(s);
                let v = [
                    narrow(x87_nan(fs, y[0], fs * y[0])),
                    narrow(x87_nan(fs, y[1], fs * y[1])),
                    narrow(x87_nan(fs, y[2], fs * y[2])),
                ];
                self.verify_op(node, r, [s, 0.0, 0.0], y, widen3(v));
                v
            }
            VECTOR_NEG | VECTOR_NORMAL => {
                let node = self.op(1);
                self.skip(2);
                let a = self.vector(SELF);
                let v = if kind == VECTOR_NEG {
                    // 211: FCHS, a sign flip of each float32.
                    [a[0] ^ 0x8000_0000, a[1] ^ 0x8000_0000, a[2] ^ 0x8000_0000]
                } else {
                    // 226: FVector::SafeNormal (the kernel).
                    crate::op_normal(a[0], a[1], a[2]);
                    kernel_vector()
                };
                self.verify_op(node, r, widen3(a), [0.0; 3], widen3(v));
                v
            }
            VECTOR_ROTATE => {
                // 276: Rotate_VectorRotator (the kernel).
                let node = self.op(1);
                self.skip(2);
                let a = self.vector(SELF);
                let b = self.rotator(SELF);
                crate::op_rotate(a[0], a[1], a[2], b[0], b[1], b[2]);
                let v = kernel_vector();
                self.verify_op(node, r, widen3(a), ints3(b), widen3(v));
                v
            }
            _ => self.fail(ERR_KIND, kind),
        }
    }

    /// A rotator value (R2b-6): the three int32 words.
    fn rotator(&mut self, r: Recv) -> [i32; 3] {
        let kind = self.op(0);
        match kind {
            LIT_ROTATOR => {
                let v = [self.op(1) as i32, self.op(2) as i32, self.op(3) as i32];
                self.skip(4);
                v
            }
            LOCAL_ROTATOR => {
                let (offset, node) = (self.op(1), self.op(2));
                self.skip(3);
                let v = load_rotator(self.locals.wrapping_add(offset));
                self.verify3(node, r, CK_ROTATOR, ints3(v));
                v
            }
            FIELD_ROTATOR => {
                let (offset, node, key) = (self.op(1), self.op(2), self.op(3));
                self.skip(4);
                match self.field(r, key, offset) {
                    Some(addr) => {
                        let v = load_rotator(addr);
                        self.verify3(node, r, CK_ROTATOR, ints3(v));
                        v
                    }
                    None => self.host_rotator(node, r),
                }
            }
            JS_ROTATOR => {
                let node = self.op(1);
                self.skip(2);
                self.host_rotator(node, r)
            }
            CONTEXT => match self.context(r) {
                Some(object) => self.rotator(object),
                None => [0; 3],
            },
            ROTATOR_ADD | ROTATOR_SUB => {
                // 316/317: ((v|0) ± (b[i]|0)) | 0 per word.
                let node = self.op(1);
                self.skip(2);
                let a = self.rotator(SELF);
                let b = self.rotator(SELF);
                let v = if kind == ROTATOR_ADD {
                    [a[0].wrapping_add(b[0]), a[1].wrapping_add(b[1]), a[2].wrapping_add(b[2])]
                } else {
                    [a[0].wrapping_sub(b[0]), a[1].wrapping_sub(b[1]), a[2].wrapping_sub(b[2])]
                };
                self.verify_op(node, r, ints3(a), ints3(b), ints3(v));
                v
            }
            ROTATOR_SCALE | SCALE_ROTATOR => {
                // 287 (rotator, float) / 288 (float, rotator): the kernel's
                // FILD, FMUL by the float32 and _ftol per word.
                let node = self.op(1);
                self.skip(2);
                let (a, s) = if kind == ROTATOR_SCALE {
                    let a = self.rotator(SELF);
                    (a, self.float(SELF))
                } else {
                    let s = self.float(SELF);
                    (self.rotator(SELF), s)
                };
                crate::op_multiply_rotator_float(a[0], a[1], a[2], narrow(fround_operand(s)));
                let w = kernel3();
                let v = [w[0] as i32, w[1] as i32, w[2] as i32];
                if kind == ROTATOR_SCALE {
                    self.verify_op(node, r, ints3(a), [s, 0.0, 0.0], ints3(v));
                } else {
                    self.verify_op(node, r, [s, 0.0, 0.0], ints3(a), ints3(v));
                }
                v
            }
            _ => self.fail(ERR_KIND, kind),
        }
    }

    /// A name value (R2b-6): the id of its folded spelling.
    fn name(&mut self, r: Recv) -> u32 {
        let kind = self.op(0);
        match kind {
            LIT_NAME => {
                let v = self.op(1);
                self.skip(2);
                v
            }
            JS_NAME => {
                let node = self.op(1);
                self.skip(2);
                self.host_name(node, r)
            }
            STATE_NAME => self.state_name(r),
            CONTEXT => match self.context(r) {
                Some(object) => self.name(object),
                None => NAME_NONE,
            },
            _ => self.fail(ERR_KIND, kind),
        }
    }

    /// IsA (invokeNative 303) with a name literal on receiver `r`.
    fn is_a(&mut self, r: Recv) -> bool {
        let (node, name) = (self.op(1), self.op(2));
        self.skip(3);
        let info = if r.handle == 0 { self.self_info() } else { r.info };
        if info & HOST != 0 {
            return self.host_bool(node, r);
        }
        let handle = self.handle(r);
        let mut row = class_entry(handle);
        if row <= RELEASED {
            row = unsafe { js_class_row(handle) };
            if row == 0 {
                return self.host_bool(node, r);
            }
        }
        // `for (cls = instance.cls; cls; cls = cls.base) if (lower(cls.record.name) === name)`.
        let v = row_has_name(row, name);
        self.verify(node, r, CK_BOOL, v as i32 as f64);
        v
    }

    pub(crate) fn int(&mut self, r: Recv) -> i32 {
        let kind = self.op(0);
        match kind {
            LIT_INT => {
                let v = self.op(1) as i32;
                self.skip(2);
                v
            }
            LOCAL_INT => {
                let v = load32(self.locals.wrapping_add(self.op(1))) as i32;
                self.skip(2);
                v
            }
            LOCAL_BYTE => {
                let v = load8(self.locals.wrapping_add(self.op(1))) as i32;
                self.skip(2);
                v
            }
            FIELD_INT | FIELD_BYTE => {
                let (offset, node, key) = (self.op(1), self.op(2), self.op(3));
                self.skip(4);
                match self.field(r, key, offset) {
                    Some(addr) if kind == FIELD_INT => load32(addr) as i32,
                    Some(addr) => load8(addr) as i32,
                    None => self.host_int(node, r),
                }
            }
            JS_INT => {
                let node = self.op(1);
                self.skip(2);
                self.host_int(node, r)
            }
            DEFAULT_INT | DEFAULT_BYTE => {
                let (offset, node, owner) = (self.op(1), self.op(2), self.op(3));
                self.skip(4);
                let v = match self.default_addr(r, owner, offset) {
                    Some(addr) if kind == DEFAULT_INT => load32(addr) as i32,
                    Some(addr) => load8(addr) as i32,
                    None => return self.host_int(node, r),
                };
                self.verify(node, r, CK_INT, v as f64);
                v
            }
            FIELD_ELEM_INT | FIELD_ELEM_BYTE | LOCAL_ELEM_INT | LOCAL_ELEM_BYTE => {
                let (addr, node, _) = self.element(r, kind);
                let v = match addr {
                    Some(addr) if kind == FIELD_ELEM_INT || kind == LOCAL_ELEM_INT => load32(addr) as i32,
                    Some(addr) => load8(addr) as i32,
                    None => return self.host_int(node, r),
                };
                self.verify(node, r, CK_INT, v as f64);
                v
            }
            CONTEXT => match self.context(r) {
                Some(object) => self.int(object),
                None => 0,
            },
            CALL | CALL_OUT => self.call(r) as i32,
            BYTE_TO_INT | INT_TO_BYTE => {
                self.skip(1);
                self.int(SELF) & 255
            }
            FLOAT_TO_INT | FLOAT_TO_BYTE => {
                self.skip(1);
                let v = fround(self.float(SELF));
                // The game's MSVCRT _ftol (0x78004dc1) stores the integer
                // indefinite for a NaN, an infinity or an int64 overflow; its
                // low dword is 0 (scripts/validate-x87-ftol-hardware.mjs).
                // `as i64` truncates toward zero; the low dword is ToInt32.
                let t = if v >= -TWO_63 && v < TWO_63 { v as i64 as i32 } else { 0 };
                if kind == FLOAT_TO_INT {
                    t
                } else {
                    t & 255
                }
            }
            INT_ADD | INT_SUB | INT_MUL | INT_AND | INT_XOR | INT_OR | INT_SHL | INT_SAR | INT_SHR | INT_MIN
            | INT_MAX | INT_DIV => {
                self.skip(1);
                let a = self.int(SELF);
                let b = self.int(SELF);
                match kind {
                    INT_ADD => a.wrapping_add(b),
                    INT_SUB => a.wrapping_sub(b),
                    INT_MUL => a.wrapping_mul(b),
                    INT_AND => a & b,
                    INT_XOR => a ^ b,
                    INT_OR => a | b,
                    INT_SHL => a.wrapping_shl(b as u32 & 31),
                    INT_SAR => a.wrapping_shr(b as u32 & 31),
                    INT_SHR => ((a as u32) >> (b as u32 & 31)) as i32,
                    INT_MIN => {
                        if a < b {
                            a
                        } else {
                            b
                        }
                    }
                    INT_MAX => {
                        if a > b {
                            a
                        } else {
                            b
                        }
                    }
                    _ => {
                        if b == 0 {
                            0
                        } else if a == i32::MIN && b == -1 {
                            self.fail(ERR_DIV_OVERFLOW, 0)
                        } else {
                            a / b
                        }
                    }
                }
            }
            INT_CLAMP => {
                self.skip(1);
                let a = self.int(SELF);
                let b = self.int(SELF);
                let c = self.int(SELF);
                if a < b {
                    b
                } else if a < c {
                    a
                } else {
                    c
                }
            }
            INT_NEG => {
                self.skip(1);
                self.int(SELF).wrapping_neg()
            }
            INT_NOT => {
                self.skip(1);
                !self.int(SELF)
            }
            ROTATOR_MEMBER => {
                // structValue over a rotator value: copyInt of the word, with
                // the member's receiver.
                let (node, index) = (self.op(1), self.op(2));
                if index > 2 {
                    self.fail(ERR_KIND, index);
                }
                self.skip(3);
                let a = self.rotator(r);
                let v = a[index as usize];
                self.verify_op(node, r, ints3(a), [0.0; 3], [v as f64, 0.0, 0.0]);
                v
            }
            PAWN_ALLIANCE => self.pawn_alliance(r, false),
            INC_LOCAL_PRE | DEC_LOCAL_PRE | INC_LOCAL_POST => {
                let addr = self.locals.wrapping_add(self.op(1));
                self.skip(2);
                let old = load32(addr) as i32;
                let new = if kind == DEC_LOCAL_PRE { old.wrapping_sub(1) } else { old.wrapping_add(1) };
                store32(addr, new as u32);
                if kind == INC_LOCAL_POST {
                    old
                } else {
                    new
                }
            }
            _ => self.fail(ERR_KIND, kind),
        }
    }

    pub(crate) fn float(&mut self, r: Recv) -> f64 {
        let kind = self.op(0);
        match kind {
            AI_CAN_SEE => self.ai_can_see(r),
            LAST_RENDERED => self.last_rendered(r),
            LIT_FLOAT => {
                let v = float_of(self.op(1));
                self.skip(2);
                v
            }
            LOCAL_FLOAT => {
                let v = float_of(load32(self.locals.wrapping_add(self.op(1))));
                self.skip(2);
                v
            }
            FIELD_FLOAT => {
                let (offset, node, key) = (self.op(1), self.op(2), self.op(3));
                self.skip(4);
                match self.field(r, key, offset) {
                    Some(addr) => float_of(load32(addr)),
                    None => self.host_float(node, r),
                }
            }
            JS_FLOAT => {
                let node = self.op(1);
                self.skip(2);
                self.host_float(node, r)
            }
            DEFAULT_FLOAT => {
                let (offset, node, owner) = (self.op(1), self.op(2), self.op(3));
                self.skip(4);
                let v = match self.default_addr(r, owner, offset) {
                    Some(addr) => float_of(load32(addr)),
                    None => return self.host_float(node, r),
                };
                self.verify(node, r, CK_FLOAT, v);
                v
            }
            FIELD_ELEM_FLOAT | LOCAL_ELEM_FLOAT => {
                let (addr, node, _) = self.element(r, kind);
                let v = match addr {
                    Some(addr) => float_of(load32(addr)),
                    None => return self.host_float(node, r),
                };
                self.verify(node, r, CK_FLOAT, v);
                v
            }
            CONTEXT => match self.context(r) {
                Some(object) => self.float(object),
                None => 0.0,
            },
            CALL | CALL_OUT => self.call(r),
            INT_TO_FLOAT => {
                self.skip(1);
                self.int(SELF) as f32 as f64
            }
            BYTE_TO_FLOAT => {
                self.skip(1);
                (self.int(SELF) & 255) as f32 as f64
            }
            VECTOR_MEMBER => {
                // structValue over a vector value: copyFloat of the float32
                // component, with the member's receiver.
                let (node, index) = (self.op(1), self.op(2));
                if index > 2 {
                    self.fail(ERR_KIND, index);
                }
                self.skip(3);
                let a = self.vector(r);
                let v = widen(a[index as usize]);
                self.verify_op(node, r, widen3(a), [0.0; 3], [v, 0.0, 0.0]);
                v
            }
            VECTOR_SIZE => {
                // 225 (finishVectorSize): f(Math.sqrt((z*z + y*y) + x*x)) in
                // doubles; Math.sqrt is correctly rounded and returns a NaN
                // operand itself.
                let node = self.op(1);
                self.skip(2);
                let a = self.vector(SELF);
                let [x, y, z] = widen3(a);
                let v = if crate::x87::precision() == 24 {
                    // Inside the render pass every FMUL, FADDP and the FSQRT
                    // round to 24 bits (the x87 model at precision control
                    // 24); the double argument store is exact then.
                    widen(crate::vector_size(a))
                } else {
                    let (xx, yy, zz) = (x * x, y * y, z * z);
                    let s = x87_nan(zz, yy, zz + yy);
                    let s = x87_nan(s, xx, s + xx);
                    fround(if s.is_nan() { s } else { crate::trace::sqrt(s) })
                };
                self.verify_op(node, r, [x, y, z], [0.0; 3], [v, 0.0, 0.0]);
                v
            }
            VECTOR_DOT => {
                // 219: the kernel's px + (py + pz), one store.
                let node = self.op(1);
                self.skip(2);
                let a = self.vector(SELF);
                let b = self.vector(SELF);
                let v = widen(crate::op_dot(a[0], a[1], a[2], b[0], b[1], b[2]));
                self.verify_op(node, r, widen3(a), widen3(b), [v, 0.0, 0.0]);
                v
            }
            FLOAT_NEG => {
                self.skip(1);
                fround(-fround(self.float(SELF)))
            }
            FLOAT_MUL | FLOAT_DIV | FLOAT_ADD | FLOAT_SUB | FLOAT_MIN | FLOAT_MAX => {
                self.skip(1);
                let a = self.float(SELF);
                let b = self.float(SELF);
                match kind {
                    // 171/172/174/175: f(a op b), a NaN result the x87's
                    // (x87_nan), not the host FPU's or the compiler's
                    // operand order.
                    FLOAT_MUL => fround(x87_nan(a, b, a * b)),
                    FLOAT_DIV => fround(x87_nan(a, b, a / b)),
                    FLOAT_ADD => fround(x87_nan(a, b, a + b)),
                    FLOAT_SUB => fround(x87_nan(a, b, a - b)),
                    // FMin (244): a > b ? b : a; FMax (245): a >= b ? a : b,
                    // on the raw values.
                    FLOAT_MIN => {
                        if a > b {
                            b
                        } else {
                            a
                        }
                    }
                    _ => {
                        if a >= b {
                            a
                        } else {
                            b
                        }
                    }
                }
            }
            _ => self.fail(ERR_KIND, kind),
        }
    }

    pub(crate) fn boolean(&mut self, r: Recv) -> bool {
        let kind = self.op(0);
        match kind {
            LIT_BOOL => {
                let v = self.op(1) != 0;
                self.skip(2);
                v
            }
            LOCAL_BOOL => {
                let v = load32(self.locals.wrapping_add(self.op(1))) & self.op(2) != 0;
                self.skip(3);
                v
            }
            FIELD_BOOL => {
                let (offset, node, key, mask) = (self.op(1), self.op(2), self.op(3), self.op(4));
                self.skip(5);
                match self.field(r, key, offset) {
                    Some(addr) => load32(addr) & mask != 0,
                    None => self.host_bool(node, r),
                }
            }
            JS_BOOL => {
                let node = self.op(1);
                self.skip(2);
                self.host_bool(node, r)
            }
            DEFAULT_BOOL => {
                let (offset, node, owner, mask) = (self.op(1), self.op(2), self.op(3), self.op(4));
                self.skip(5);
                let v = match self.default_addr(r, owner, offset) {
                    Some(addr) => load32(addr) & mask != 0,
                    None => return self.host_bool(node, r),
                };
                self.verify(node, r, CK_BOOL, v as i32 as f64);
                v
            }
            FIELD_ELEM_BOOL | LOCAL_ELEM_BOOL => {
                let (addr, node, mask) = self.element(r, kind);
                let v = match addr {
                    Some(addr) => load32(addr) & mask != 0,
                    None => return self.host_bool(node, r),
                };
                self.verify(node, r, CK_BOOL, v as i32 as f64);
                v
            }
            CONTEXT => match self.context(r) {
                Some(object) => self.boolean(object),
                None => false,
            },
            CALL | CALL_OUT => self.call(r) != 0.0,
            NOT => {
                self.skip(1);
                !self.boolean(SELF)
            }
            AND | OR => {
                let length = self.op(1) as usize;
                self.skip(2);
                let a = self.boolean(SELF);
                // && with false, || with true: the Skip operand is not
                // evaluated.
                if a != (kind == AND) {
                    self.skip(length);
                    return a;
                }
                self.boolean(SELF)
            }
            BOOL_NE | BOOL_EQ => {
                self.skip(1);
                let a = self.boolean(SELF);
                let b = self.boolean(SELF);
                (a == b) == (kind == BOOL_EQ)
            }
            INT_LT | INT_GT | INT_LE | INT_GE | INT_EQ | INT_NE => {
                self.skip(1);
                let a = self.int(SELF);
                let b = self.int(SELF);
                match kind {
                    INT_LT => a < b,
                    INT_GT => a > b,
                    // Natives 152/153 (script-decoration-primitives.mjs).
                    INT_LE => a <= b,
                    INT_GE => a >= b,
                    INT_EQ => a == b,
                    _ => a != b,
                }
            }
            FLOAT_LE => {
                // Native 178: !(f(a ?? 0) > f(b ?? 0)); unordered is true.
                self.skip(1);
                let a = self.float(SELF);
                let b = self.float(SELF);
                !(fround(undef_zero(a)) > fround(undef_zero(b)))
            }
            FLOAT_LT | FLOAT_GT | FLOAT_GE => {
                self.skip(1);
                let a = self.float(SELF);
                let b = self.float(SELF);
                match kind {
                    FLOAT_LT => a < b,
                    FLOAT_GT => a > b,
                    _ => a >= b,
                }
            }
            FLOAT_EQ | FLOAT_NE => {
                // FCOMP tests C3 only: unordered compares equal.
                self.skip(1);
                let x = fround(self.float(SELF));
                let y = fround(self.float(SELF));
                let equal = x.is_nan() || y.is_nan() || x == y;
                equal == (kind == FLOAT_EQ)
            }
            FLOAT_NEAR => {
                self.skip(1);
                let x = fround(self.float(SELF));
                let y = fround(self.float(SELF));
                let d = x - y;
                d.is_nan() || (d < 0.0001 && d > -0.0001)
            }
            OBJECT_EQ | OBJECT_NE => {
                self.skip(1);
                let a = self.object(SELF);
                let b = self.object(SELF);
                (a == b) == (kind == OBJECT_EQ)
            }
            VECTOR_EQ | VECTOR_NE => {
                // 217/218 FCOMP each component, testing C3 only: a NaN on
                // either side compares equal, as do +0 and -0.
                let node = self.op(1);
                self.skip(2);
                let a = self.vector(SELF);
                let b = self.vector(SELF);
                let (x, y) = (widen3(a), widen3(b));
                let mut equal = true;
                for i in 0..3 {
                    if !(x[i].is_nan() || y[i].is_nan() || x[i] == y[i]) {
                        equal = false;
                    }
                }
                let v = equal == (kind == VECTOR_EQ);
                self.verify_op(node, r, x, y, [v as i32 as f64, 0.0, 0.0]);
                v
            }
            ROTATOR_EQ | ROTATOR_NE => {
                // 142/203: three dword compares.
                let node = self.op(1);
                self.skip(2);
                let a = self.rotator(SELF);
                let b = self.rotator(SELF);
                let v = ints_eq(&a, &b) == (kind == ROTATOR_EQ);
                self.verify_op(node, r, ints3(a), ints3(b), [v as i32 as f64, 0.0, 0.0]);
                v
            }
            NAME_EQ | NAME_NE => {
                // 254/255: the folded spellings' ids.
                let node = self.op(1);
                self.skip(2);
                let a = self.name(SELF);
                let b = self.name(SELF);
                let v = (a == b) == (kind == NAME_EQ);
                self.verify_op(node, r, [a as f64, 0.0, 0.0], [b as f64, 0.0, 0.0], [v as i32 as f64, 0.0, 0.0]);
                v
            }
            IS_A => self.is_a(r),
            PAWN_ENEMY => self.pawn_alliance(r, true) != 0,
            IN_STASIS => self.in_stasis(r),
            _ => self.fail(ERR_KIND, kind),
        }
    }

    pub(crate) fn object(&mut self, r: Recv) -> u32 {
        let kind = self.op(0);
        match kind {
            LIT_NONE => {
                self.skip(1);
                0
            }
            LOCAL_OBJECT => {
                let v = live(load32(self.locals.wrapping_add(self.op(1))));
                self.skip(2);
                v
            }
            FIELD_OBJECT => {
                let (offset, node, key) = (self.op(1), self.op(2), self.op(3));
                self.skip(4);
                match self.field(r, key, offset) {
                    Some(addr) => live(load32(addr)),
                    None => self.host_object(node, r),
                }
            }
            FIELD_ELEM_OBJECT | LOCAL_ELEM_OBJECT => {
                let (addr, node, _) = self.element(r, kind);
                let v = match addr {
                    Some(addr) => live(load32(addr)),
                    None => return self.host_object(node, r),
                };
                self.verify(node, r, CK_OBJECT, v as f64);
                v
            }
            JS_OBJECT => {
                let node = self.op(1);
                self.skip(2);
                self.host_object(node, r)
            }
            DYNAMIC_CAST => {
                let (rid, node) = (self.op(1), self.op(2));
                self.skip(3);
                // compileEv 0x2e: the value with SELF, once, then the test.
                let value = self.object(SELF);
                self.cast(value, rid, node)
            }
            SELF_OBJECT => {
                self.skip(1);
                self.self_handle
            }
            CONTEXT => match self.context(r) {
                Some(object) => self.object(object),
                None => 0,
            },
            CALL | CALL_OUT => self.call(r) as u32,
            PLAYER_PAWN => self.player_pawn(r),
            _ => self.fail(ERR_KIND, kind),
        }
    }
}

/// Run one lowered function body from statement `entry`. Returns -1 after a
/// Return (a typed value is in RESULT) or the index of the S_YIELD statement
/// the JavaScript loop must execute next.
#[no_mangle]
pub extern "C" fn vm_run(code: u32, frame: u32, locals: u32, self_handle: u32, entry: u32) -> i32 {
    let code = code as usize as *const u32;
    let mut run = Run { code, pc: code, frame, locals, self_handle, self_info: 0, self_bind: 0, self_fresh: false, callee: false, iter: crate::iter::NO_ITER };
    run.statements(entry)
}

/// Run statement `index` of a lowered state body (see the header): 1 when a
/// jump is taken, else 0.
#[no_mangle]
pub extern "C" fn vm_statement(code: u32, frame: u32, locals: u32, self_handle: u32, index: u32) -> i32 {
    let code = code as usize as *const u32;
    let mut run = Run { code, pc: code, frame, locals, self_handle, self_info: 0, self_bind: 0, self_fresh: false, callee: false, iter: crate::iter::NO_ITER };
    unsafe { SCRIPT_RUNS = SCRIPT_RUNS.wrapping_add(1) };
    run.statement(index)
}
