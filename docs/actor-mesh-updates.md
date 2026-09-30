# Actor mesh update work

The display adapter retains the recovered [GetFrame](script-lodmesh-frame.md),
[material](script-lodmesh-materials.md), and [mesh lighting](mesh-lighting.md)
contracts. This change removes repeated host work without choosing different
poses, lighting candidates, visibility, or material order.

## Equal lighting attributes

Original DrawLodMesh lighting still runs once for each drawn actor in the main
frame, including SetupForActor's light-cache updates, fades and trace cadence.
The output remains the recovered packed diffuse bytes divided by 255 and
stored as Float32. The adapter still reverses each face's corners from 0,1,2
to 0,2,1 for the coordinate reflection.

Before copying a draw group's colors, the adapter compares their exact 32-bit
words with the current GPU attribute. An equal group needs no new upload. On
the first difference it copies that face and the remaining faces, then marks
the attribute dirty. This does not cache lighting results or skip calculation.
The source view is renewed when the lighting output identity changes, including
after Wasm memory growth; its live words are read again on every call.

A 60-frame walking Island browser census found 14,363 of 31,575 group updates
already equal (45.5%, about 239 calls per frame). Their 10,306,944 bytes were
14.1% of the 72,939,960 color bytes written. These are avoided buffer updates
and bytes, not a claimed frame-rate gain. Local capture:
`.work/mesh-upload-census.json`.

A separate actual Island frame after 60 walking ticks had 252 of 528 groups
equal, saving 201,312 of 1,221,984 bytes. Every new scatter result matched the
old scatter exactly. Alternating local CPU blocks measured approximately
0.263 ms for the old scatter and 0.259 ms for the guarded scatter, including
the same target-reset overhead; that small timing difference is inconclusive.
The intended benefit is fewer graphics API buffer updates.

Two focused word-scatter tests cover every reflected corner, reordered faces,
late differences, sliced storage and exact bit comparison. The Training scene
integration check also verifies lighting still executes on equal frames,
changed colors upload once, source-view replacement is safe, and exact colors
reach every group. Existing native lighting evidence is reused; these checks
establish the changed upload boundary rather than whole-renderer fidelity.

## Live Mesh polling

Admission first rejects an already bound or pending identity before reading
its Mesh again. Reconciliation still checks bound actors for a changed Mesh;
an unbound identity still reads its current Mesh on every update, so a script
can make a previously meshless actor drawable. The asynchronous decoder,
retirement/readmission order, and private GetFrame caches are unchanged.

In the static full Island scene, moving the admission guards avoids 293
redundant Mesh reads. Exact geometry, UV, light and material signatures agree.
Static adapter timing does not establish a whole-frame gain from this small
lookup change. A separate bound-accessor cache experiment was discarded because
it did not demonstrate a clear adapter-time improvement.

Run `node --test test/mesh-light-colors.test.mjs` and
`node scripts/validate-actor-mesh-scene.mjs`. The latter retains the real-script
Mesh swap, removal/readmission, owned-tool visibility, material and resource
checks alongside the new color-upload boundary checks.
