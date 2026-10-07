# X embed: the menu logo scene

A static page that shows the Deus Ex menu logo scene (`DXOnly.dx`) in WebGL.
It carries the meta tags of an X (Twitter) **player card**. X shows the card
image with a play button, and clicking it loads the same page in an iframe
inside the post.

It is a showcase beside the browser runtime, not part of it. The geometry,
textures, placements and rates come from the original data. The lighting and
the electricity are approximations (see the table below).

## Build

```sh
node embed/build.mjs --url https://your-host.example/path/
```

- Reads `Deus Ex GOTY Edition/` (or `DEUS_EX_GAME_DIR`) through the project's
  package readers and writes a static site to `embed/out/`.
- `--url` is the absolute HTTPS address the site will be served from. X ignores
  card tags with relative URLs, so a build without it is only for local viewing.
  It also renders `card.png`, the card's still image, with Playwright.
- `--poster` renders `card.png` for a local build.

`embed/out/` contains original assets (the logo and text meshes and three
textures). It is ignored by Git, like the rest of the game data.

Preview it locally:

```sh
node embed/serve.mjs
```

Then open `http://127.0.0.1:5180/`. The card frames it at 480×480, so test
that size too.

Deployed at `https://deus-ex-logo.pages.dev/` (Cloudflare Pages project
`deus-ex-logo`). To update it:

```sh
node embed/build.mjs --url https://deus-ex-logo.pages.dev/
wrangler pages deploy embed/out --project-name deus-ex-logo --branch main --commit-dirty=true
```

## Publish

Upload the contents of `embed/out/` to any static HTTPS host at the URL given
to `--url`. `_headers` (read by Cloudflare Pages and Netlify) lets x.com and
twitter.com frame the page. Hosts that ignore it still allow framing, because
the page sends no `X-Frame-Options`.

Post the root URL on X. Historically X rendered player cards only for
approved domains. On 2026-10-07 a new `deus-ex-logo.pages.dev` domain got
the play button and the framed page without any approval step. If a post ever
shows a plain link card instead, the page still works as a link.

## Original and approximated

| Part | Source |
| --- | --- |
| Logo mesh `DeusExDeco.DXLogo` (classic UMesh, 814 triangles) | Original, decoded with the shared `serializeMesh` |
| "DEUS" / "EX" quads `DeusExDeco.DXText`, skins `DXTextTex1`/`DXTextTex2` | Original |
| Placements, DrawScale 2.25, PHYS_Rotating at 8192 units/s | `DXOnly.dx` actors and `DeusEx.DXLogo`/`DXText` defaults |
| View: PlayerStart, BaseEyeHeight 40, FOV 75 (`DefUser.ini`) | Original; the vertical extent of 4:3 is kept and widened on narrow screens |
| Chrome: `PF_Environment` with `DXLogoTex1`, UV = (1 + R.xy)/2 in world axes | Recovered DrawGouraudPolygon path (`src/runtime/mesh-environment.mjs`) |
| Light colours | Original Light actors through Engine `FGetHSV` |
| Light falloff, N·L and the display gain of 2 | Approximation, set by eye |
| Translucent text: D3D ONE / INVSRCCOLOR, unlit glow | Original rule; display gain as above |
| Electricity: random aim per tick, trace to the 1024-unit BlackMaskTex room, 50% flicker every 0.02 s, `len/15 + 1` LaserBeam sticks placed by the bRandomBeam walk | `ElectricityEmitter` script and [lasers](../docs/lasers.md) |
| Stick drawing and `Nano_SFX` | Approximation: camera-facing strips at least 1.4 px wide, shaded from the Fire.dll texture's palette rather than its simulation |
| Ambient sound (`Electricity4`) and title music | Not included |
