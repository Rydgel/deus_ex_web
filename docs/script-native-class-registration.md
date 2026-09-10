# Native class registration identities

The authority is the installed GOTY Core.dll, hash recorded in
[script-object-lifecycle.md](script-object-lifecycle.md), and its PE export,
vtable and constructor records. Native class identity is not interchangeable
with an arbitrary package export. In particular, Core.Class is registered by
the DLL and its static class object is exported as
`?PrivateStaticClass@UClass@@0V1@A` at `101f1c18`; the script package does not
provide the ordinary serialized Class export expected by AssetStore.resolve.

These constructor inputs are recovered from the named registration bodies.
Addresses are from the original binary, not host object indices.

| Class | Registration body | Static UClass address | Instance size | Super argument | Within argument | Input class flags |
| --- | --- | --- | ---: | --- | --- | ---: |
| Core.Object | 10150cc0 | 1029e0d0 | 28 | Core.Object (self) | Core.Object | 1 |
| Core.Field | 10125e50 | 101f2b18 | 34 | Core.Object | Core.Object | 1 |
| Core.Struct | 101273d0 | 101f2618 | 6c | Core.Field | Core.Object | 0 |
| Core.State | 10127760 | 101f2118 | 484 | Core.Struct | Core.Object | 0 |
| Core.Class | 10128750 | 101f1c18 | 4f4 | Core.State | Core.Package | 0 |
| Core.Package | 1015a710 | 1029b8e0 | 34 | Core.Object | Core.Object | 0 |
| Core.Property | 10165650 | 102a7af0 | 5c | Core.Field | Core.Field | 1 |
| Core.ObjectProperty | 10166fc0 | 102a61f0 | 64 | Core.Property | Core.Field | 0 |
| Core.ClassProperty | 101671c0 | 102a5cf0 | 68 | Core.ObjectProperty | Core.Field | 0 |

All numbers in this table are hexadecimal. The routines supply package string
`Core` at `101a7ef4`, config string `System` at `101a82c8`, a zero FGuid, raw
object flags `04084004`, and concrete instance/static constructor pointers.
For example, `101671f4` passes ObjectProperty's static class as the Super of
ClassProperty. This directly proves the ancestry used by the object-property
iterator in [reference cleanup](script-cleanup.md).

The shared UClass native constructor thunk `10102d9c` enters `10128630`.
It passes Super to the UStruct native constructor, replacing a self Super with
null (`10128630–1012865c`). It stores input class flags OR `12` at `+484`,
the FGuid at `+48c`, Within at `+49c`, config input at `+4a0`, native instance
constructor at `+4e0`, and static constructor at `+4e4`, then installs the
UClass vtable `101758f4`. It explicitly initializes its array/count fields and
state masks. The constructor inputs are not a substitute for the later
registration, default-object and class-linking phases.

The constructor translation in `script-native-class-construction.mjs` composes
the recovered UObject constructor with these native writes. UStruct's native
constructor (`10125ef0`, called at `1012865c`) always supplies the static
Core.Class identity `101f1c18` to UObject, writes Super at `+28`, zeroes
`+2c,+30,+34,+38,+44,+48,+4c,+50,+54,+58,+5c,+60,+64,+68`, then writes the
instance size at `+3c` and UStruct vtable `10175698` at `+0`.
It does **not** write FriendlyName at `+40`.

After this base call, UClass writes the following sequence (`10128671–1012873e`):

1. ClassFlags OR `12` at `+484`.
2. GUID word 0 at `+48c`, zeroes `+4a4,+4a8`; GUID word 1 at `+490`,
   zeroes `+4ac,+4b0`; GUID word 2 at `+494`, zeroes `+4b4,+4b8`;
   GUID word 3 at `+498`, zeroes `+4bc,+4c0,+4c4`.
3. Within at `+49c`, zeroes `+4c8,+4cc,+4d0,+6c,+74,+4d4,+4d8,+4dc,+70,+78,+7c`.
4. A **two-byte** zero at `+80`, a four-byte zero at `+488`, static constructor
   at `+4e4`, zeroes `+4e8,+4ec,+4f0`, instance constructor at `+4e0`, UClass
   vtable at `+0`, and the config text pointer at `+4a0`.

Raw offset holders retain object identities and text pointers until the later
registration phases convert them. The host supplies canonical Core.Class;
the translation never creates a replacement metaclass. Fields used by class
registration have live aliases into those holders, so superclass, flags,
config-name and default-array changes do not fork into independent copies.
Absent fields stay absent, including `+40` and the padding above the word at
`+80`; zero-filled static allocation is a separate caller responsibility.
This translation covers the constructor calls, not native package discovery or
the complete UStruct/UClass registration and linking chain.
The [registration-order trace](script-native-registration-order.md) follows the
native header queue, Name/Outer conversion, array/hash insertion and reached
UClass post-registration calls. In particular, the constructor requires raw
gate `102a2648` to be zero; the Core.Class instance/static constructor pointers
are `10102e0a` at `+4e0` and `10101041` at `+4e4`, respectively.
The constructor integration check uses those original Core.Class inputs and
Core.Object's self-Super inputs. Core.Object's registration pushes instance
constructor `101017da` at `10150cc7` and static constructor `10101041` at
`10150cc2`. It also checks that a preexisting FriendlyName and the padding
beside the `+80` word survive construction. Registration callbacks deliberately
reject entry in this constructor-only reference case.

The PE vtable Serialize entries establish the next metadata GC paths:

| Native instance class | Instance vtable | Serialize thunk | Serialize body |
| --- | --- | --- | --- |
| UObject | 10179dfc | 1010178f | 10150210 |
| UField | 1017561c | 10101d8e | 10125c70 |
| UStruct | 10175698 | 10102b5d | 10126fe0 |
| UState | 101757d8 | 10101776 | 10127590 |
| UClass | 101758f4 | 101011f9 | 101280d0 |
| UProperty | 10175a44 | 1010147e | 10165020 |
| UObjectProperty | 10175e04 | 1010273e | 10166bf0 |
| UClassProperty | 10175ec4 | 101017ee | 10167050 |
| UNameProperty | 10175f84 | 1010147e | 10165020 |
| UStructProperty | 10176344 | 10101717 | 101695c0 |
| UPackage | 101753a0 | 10102ce3 | 1015a470 |

An actor's class reference reaches a UClass object during collection, and that
object uses the UClass serializer, not UObject's base serializer alone. Its
field/state/property objects likewise require these distinct overrides. The
[class/state chain](script-class-serialization.md) and
[property-object serializers](script-property-serialization.md) now implement
their collector paths with explicit mutable storage and unresolved helper
boundaries. Complete native class bootstrap, remaining tagged-default bindings and the linked graph
remain required before a loaded class graph can be collected. No synthetic
Core.Class export or empty serializer is supplied to bypass those dependencies.
