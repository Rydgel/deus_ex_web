# Extracted game data — 2026-09-09

This records the initial extraction milestone. The later [rendering
contract](rendering.md) supersedes the texture/viewer limitations below: Stage 1
now renders training, and Color/Scale decoding reduces its opaque property count
from 3,400 to 1,364. The original geometry and package counts remain valid.

The user supplied an installed tree at `Deus Ex GOTY Edition/`. The tools read it
in place; the directory is ignored by Git. No executable was run or asset uploaded.

## Package validation

All 219 recognized package files parse: 88 maps, 38 object/script packages,
56 texture packages, 35 music packages, and two sound packages. Every imported
package name resolves to another parsed package in the installation. This checks
package-level availability, not every imported object's runtime implementation.

215 packages use version 68. Four texture packages use version 61:
`CoreTexDetail`, `CoreTexWater`, `Palettes`, and `Render`. Supporting them required
the older heritage-table header and null-terminated name strings. The modern
header and length-prefixed strings remain unchanged for versions 68–69.

## World geometry

All 88 maps decode their Level reference, actor list, compiled world Model, BSP
nodes, points, vectors, surfaces, vertex pool, zones, light-map metadata/bits,
bounds, hull entries, leaves, and light references. The world model is selected
from `Level.Model`; editor brush models are not substituted for the compiled world.

Convex node polygons are triangulated as fans, retaining their source surface IDs.
Invisible surfaces (`PolyFlags & 1`) are omitted from diagnostic geometry by
default. Coordinates are not transformed: original Unreal units, Z up. The OBJ
export contains static world geometry only, without materials or normals.

The full pass produced 1,958,568 visible triangles across the 88 maps and parsed
property tags for 130,787 actor records. These counts demonstrate data extraction,
not complete runtime support or visual fidelity.

## Training baseline

| Field | Value |
| --- | ---: |
| Map | `Maps/00_Training.dx` |
| Package version / licensee version | 68 / 0 |
| Compiled world model | `Model36` (export 1180) |
| Points | 16,399 |
| BSP nodes | 9,524 |
| Surfaces | 5,333 |
| Visible triangles | 25,674 |
| Non-null actor records | 1,308 |
| Light-map entries | 5,029 |
| Serialized lighting bytes | 1,167,531 |

Input SHA-256:
`bb66d95aafc6aae4179f8444e98661f3d5d27dab06d13d7dde7f4b5f4e24068d`.

The stored player start is `PlayerStart1` at
`[-1149.2435302734375, 825.8439331054688, -65.1034927368164]`.
It has no stored Rotation override; interpreting that requires class defaults.

## Format boundaries that matter next

- The vertex pool contains dead slots whose point indices are outside the current
  point array. Training has 19,298 such **unreferenced** slots. We validate every
  vertex used by a BSP polygon and report stale unused entries. A synthetic test
  ensures invalid live references still fail.
- Level data has an additional 22 or 23 bytes after reach specifications. Those
  bytes are preserved as `trailingData`; their meaning remains unknown.
- Stored scalar, vector, rotator, string, name, object, and boolean properties
  decode. Arrays and other structs are preserved as opaque bytes in the object
  reader and counted in map summaries. Training has 3,400 opaque property tags,
  including Region structs. A successfully read tag is not necessarily a decoded value.
- Only serialized overrides are read. Class inheritance/defaults, native actor
  payloads, scripts, textures, rendered lighting, and gameplay are future work.
- Object state-frame prefixes are consumed to locate the property list correctly;
  no UnrealScript state is executed.

## Reproduce

```sh
npm test
node scripts/inventory.mjs > reports/packages.json
node scripts/validate-game.mjs > reports/map-validation.json
npm run export:training
```

Fourteen synthetic tests pass, and both real-data commands exit successfully.
The export creates a source-coordinate OBJ, actor metadata, a summary, and a
top-down SVG footprint. On macOS, a PNG preview can be generated with:

```sh
qlmanage -t -s 1200 -o reports/00_Training reports/00_Training/footprint.svg
```

## References

The implementation is written in JavaScript for this project. Serialized field
layouts were checked against SurrealEngine's open-source readers:

- [Package tables](https://github.com/dpjudas/SurrealEngine/blob/master/SurrealEngine/Package/Package.cpp)
  and [strings/compact indices](https://github.com/dpjudas/SurrealEngine/blob/master/SurrealEngine/Package/PackageStream.cpp).
- [Object properties and state frames](https://github.com/dpjudas/SurrealEngine/blob/master/SurrealEngine/Packages/Core/UObject.cpp).
- [Level base](https://github.com/dpjudas/SurrealEngine/blob/master/SurrealEngine/Packages/Engine/Resources/Level/ULevelBase.cpp),
  [Level](https://github.com/dpjudas/SurrealEngine/blob/master/SurrealEngine/Packages/Engine/Resources/Level/ULevel.cpp),
  [Model](https://github.com/dpjudas/SurrealEngine/blob/master/SurrealEngine/Packages/Engine/Resources/Level/UModel.cpp),
  and [Primitive](https://github.com/dpjudas/SurrealEngine/blob/master/SurrealEngine/Packages/Engine/Resources/UPrimitive.cpp).

The native engine is not linked or bundled. See the upstream
[license information](https://github.com/dpjudas/SurrealEngine/blob/master/LICENSE.md).
