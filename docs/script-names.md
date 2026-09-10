# Core FName table release and reuse

This contract is recovered from the hash-verified GOTY `Core.dll` in
`.cache/research/Core.asm`. It covers the mutable name-table path needed by
the Stage 3 garbage collector. The reflected name serializers and native
startup registration remain separate callers.

`FName::DeleteEntry` is the Core thunk at `0x10102680`; it jumps to body
`0x1014e0b0` and receives a name-table index. The original tables are:

| Original address | Table | Host representation |
| --- | --- | --- |
| `0x102961f0` | `GNames` data pointer | `names[]`, retaining null holes |
| `0x102961f4` | `GNames` count | `nameCount` |
| `0x102961f8` | `GNames` capacity | `nameCapacity` |
| `0x102961e0` | `GNameAvail` data pointer | `freeIndices[]`, used as a stack |
| `0x102961e4` | `GNameAvail` count | `freeIndices.length` |
| `0x102961e8` | `GNameAvail` capacity | `freeNameCapacity` |
| `0x102961fc` | 4096 hash bucket heads | `buckets[0x1000]` |

Each native `FNameEntry` begins with four fields used by this path:

| Offset | Meaning | Host field |
| ---: | --- | --- |
| `+0x00` | stable name index | `entry.index` |
| `+0x04` | entry flags | `entry.flags` |
| `+0x08` | next entry in a hash bucket | `entry.hashNext` |
| `+0x0c` | null-terminated UTF-16 text | `entry.text` |

The constructor's length/copy helpers are native wide-string operations:
`appStrlen` stops at the first UTF-16 NUL and `appStrcpy` copies that
terminated prefix. The adapter applies the same rule at every name boundary,
so an input containing a NUL after `Door` interns the spelling `Door` and
never retains the suffix.

`src/runtime/script-names.mjs` exposes `createScriptNames`, which keeps these
arrays live and returns `deleteEntry(index)`, `find(text)`, and the optional
`intern(text, findType)` path. The caller supplies `allocator.free(entry)` for
the native `GMalloc` virtual `+0x08` operation; the default entry allocator is
a plain host record because JavaScript owns the table storage.

## DeleteEntry order

The body first loads `GNames[index]`. A null entry is an assertion failure.
It also asserts when the entry has flag `0x04000000`; this is the native or
hardcoded-name protection used by the GC native gate. The host rejects that
case before mutation so a missing native-class gate cannot free a protected
entry silently.

The body hashes the text stored in the entry, masks the result with `0xfff`,
and walks that bucket's singly linked chain by `+0x08` until it finds the
same entry pointer. It patches the bucket head or predecessor link to the
entry's saved next pointer. The order after unlinking is fixed:

1. Call `GMalloc` virtual slot `+0x08` on the entry.
2. Store null in `GNames[index]`.
3. Append `index` to the end of `GNameAvail`.

The name count and the GNames array length do not shrink. Reuse therefore
takes the last free index first. If an index is not found in its computed
bucket, the original diagnostic path logs and then relies on the native chain
invariant; the host throws before mutating the table so the broken state is
visible.

The free-array growth calculation at `0x1014e1f1–0x1014e203` is

```text
newCapacity = newCount + floor(3 * newCount / 8) + 0x20
```

The exact reuse call is `FArray::Remove(lastIndex,1,4)`, whose generic body is
`0x101454f0`. After the removal it considers shrinking when
`3 * newCount < 2 * oldCapacity`; it then requires at least `0x4000` excess
bytes (`4 * (oldCapacity - newCount)`) and either more than `0x40` spare
elements or an empty result. When those conditions hold, the native capacity
becomes `newCount`; otherwise it remains unchanged. The JavaScript adapter
records this logical capacity while using the live array's normal storage.

## Hash contract

Core initializes the 256-entry CRC table at `0x10149840`. Each entry starts at
`index << 24` and performs eight left shifts, XORing `0x04c11db7` when the
high bit was set. The FName hash loop in `FName::FName` body `0x1014b950` and
`DeleteEntry` body `0x1014e0b0` then use that table in the following order for
each UTF-16 code unit:

1. Convert only ASCII `a`–`z` to uppercase.
2. Update with the low byte: `hash = (hash >>> 8) ^ table[(hash ^ low) & 0xff]`.
3. Update with the high byte using the same rule.
4. Mask the final state with `0xfff` for the bucket.

This is the observed name-table hash. It is distinct from the left-shifting
`appStrCrc` update in the same Core image, even though both use the initialized
table.

## Interning and index reuse

The `FName(const TCHAR*,EFindName)` body at `0x1014b950` computes the same
bucket, compares text with case-insensitive `appStricmp` (`0x1010239c`), and
returns an existing entry's index without mutation. An empty string writes
index zero. A find-only mode writes index zero when no entry exists.

For an add mode, the body pops the last `GNameAvail` index and removes that
last FArray element with `FArray::Remove(index,1,4)`, including the conditional
capacity policy above. If no reusable index is available, it appends at the
old GNames count, increments the count, and grows the array with the same
capacity formula. It then calls
`AllocateNameEntry` (`0x10101d52` → body `0x1014e430`) with the text, index,
flags, and old bucket head. The allocator size is `2 * strlen(text) + 0x0e`
bytes, and the helper stores the four native fields above. The new entry is
installed as the bucket head and GNames slot. Numeric find mode `2` ORs
`0x04000000` into a newly allocated entry's flags; when a case-insensitive
match already exists, the constructor returns that entry immediately and does
not change its flags, even when the request used mode `2`. The normal add mode
leaves new-entry flags clear.

The existing-name comparison calls `appStricmp` thunk `0x1010239c`, whose body
`0x10123560` forwards to MSVCRT `_wcsicmp` through IAT `0x102ab4c8`. The
original process uses the C locale for this path, so the adapter's verified
folding is ASCII `a`–`z` to `A`–`Z`, applied to UTF-16 code units. Locale
dependent non-ASCII equivalence has not been established and is explicitly
outside this host adapter.

The adapter returns `{index,name,entry,created}` from `intern`, which lets the
object-construction boundary retain both the resolved FName index and its
canonical spelling. The GC should call `deleteEntry` only after its native
flag gate has excluded `0x04000000` entries.

## Validation and boundaries

`test/script-names.test.mjs` exercises the recovered hash bucket, unlink and
allocator order, null slot, NUL-terminated text, LIFO free-index reuse,
existing-name mode-2 flag stability, and case-insensitive lookup with a compact
fixture. The module does not implement startup hardcoded-name registration,
reflected serializers, locale changes, or arbitrary malformed native entries;
those callers must provide the original table records and allocator service.
