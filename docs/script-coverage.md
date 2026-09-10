# Script and native coverage inventory

Run `node scripts/inventory-script-runtime.mjs` against the local installation.
It writes `.cache/script-runtime-inventory.json`, including package hashes,
native declarations, direct native call counts, final calls to native functions,
virtual call names and decoded opcode counts. Original bytecode and resource
payloads are not copied into the report.

The current installation produces this inventory:

| Package | Functions | States | Native declarations |
| --- | ---: | ---: | ---: |
| Core | 170 | 0 | 165 |
| Engine | 1,263 | 65 | 158 |
| Extension | 555 | 0 | 453 |
| ConSys | 51 | 0 | 11 |
| DeusEx | 4,933 | 185 | 57 |
| UWindow | 723 | 1 | 0 |
| DeusExUI | 0 | 0 | 0 |
| Fire | 0 | 0 | 0 |
| Total | 7,695 | 251 | 844 |

All 7,946 function/state streams decode without format errors. This is decoding
coverage, not execution coverage. The streams contain 581 distinct direct native
indices. Fifty native declarations have index zero (11 Core, 39 Engine) and need
their named/native-hook route; they cannot be treated as one shared native-zero
implementation. The inventory does not resolve every virtual call or count its
runtime frequency.

The report lists the VM's primitive indices and explicitly scoped common/door
bindings. A listed binding does not establish every branch of that native.
For example, mover SetPhysics only accepts an already active MovingBrush mode,
and PlaySound records a deferred effect without producing audio. Stage 2 contains
additional recovered engine helpers whose general script call bindings remain
open work.

UI and conversation work therefore includes native implementations in Extension
and ConSys, in addition to loading the corresponding script packages. Frequently
called incompletely bound families include strings, object/class queries, actor spawning,
flag storage and Window construction/layout. Inventory order is a guide for
selecting original routines to trace; it does not replace their source contract.

The [runtime scope](script-runtime.md) documents the currently executable subset.
Core GC marking/purge orchestration and deferred actor-reference cleanup have
source-backed modules with explicit native lifecycle/serialization boundaries.
Actor/UObject collector serialization is bound to live CameraPoint storage,
including active state references. FName table operations and the typed GC
reference bridge also have focused integration coverage. These are components
of collection, not a complete class/resource graph or save serializer.
Native metadata overrides cover the UField/UStruct/UState/UClass chain and
property subclasses, with original Owner-property and Idle-state integration
checks. Bytecode collection follows native cursor order and shares operand
storage with execution. Tagged-default traversal/default filtering is translated;
its native measuring archive is connected through the GC bridge to live Owner
default storage. Complex-property virtuals and complete typed class storage
remain explicit integration dependencies.
Native UObject queue/registration, UStruct/UClass construction and UClass default
storage initialization now have bounded translations. UField/UStruct registration
and native hash/path lookup are connected, including CreatePackage's existing
package path. Registration can invoke the recovered UClass::Link layer;
native net-field ordering and UStruct/UState linking are connected. The original
Core.Object registration composition passes through those layers and the native
config/localization gates without stand-in callbacks. Byte/Int/Float/Name/Object/Class
property Link bodies now compose with the struct linker. Complex property Link
virtuals and config/localization resource services remain open. Constructor fields
share mutable storage with the registration/serialization adapters. These paths
do not yet constitute the complete native class loader.
Broader actor creation/destruction, native class registration, complete garbage
collection integration, serialization, broader native dispatch and game/UI
behavior remain Stage 3 work.
