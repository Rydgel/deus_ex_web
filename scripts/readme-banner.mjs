// Draws docs/readme/banner.svg, the README banner: an original night skyline over a perspective grid.
// Deterministic (seeded PRNG), no dependencies, no game data. Usage: node scripts/readme-banner.mjs [out.svg]
import {writeFileSync} from 'node:fs';

const W = 1280, H = 320, HORIZON = 246;
let seed = 0x5eed1e55;
const rand = () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const r = (a, b) => a + (b - a) * rand();
const ri = (a, b) => Math.floor(r(a, b + 1));
const f = (n) => Number(n.toFixed(1));

function layer({x0, x1, minW, maxW, minH, maxH, gap, lit, litCyan, winW, winH, stepX, stepY, towers = []}) {
  const shapes = [];
  const amber = [], cyan = [];
  let x = x0;
  while (x < x1) {
    const w = ri(minW, maxW);
    let h = ri(minH, maxH);
    const tower = towers.find((t) => x <= t.at && t.at < x + w + gap);
    if (tower) h = tower.h;
    const top = HORIZON - h;
    // Body, with an optional setback crown.
    let d = `M${x} ${HORIZON}V${top}H${x + w}V${HORIZON}Z`;
    if (h > minH + (maxH - minH) * 0.45 && rand() < 0.55) {
      const inset = Math.max(3, Math.round(w * r(0.18, 0.3)));
      const ch = ri(8, 22);
      d += `M${x + inset} ${top}V${top - ch}H${x + w - inset}V${top}Z`;
      if (rand() < 0.6) {
        const ax = Math.round(x + w / 2);
        const ah = ri(10, 30) + (tower ? 26 : 0);
        d += `M${ax - 1} ${top - ch}V${top - ch - ah}H${ax + 1}V${top - ch}Z`;
        if (tower) shapes.push({beacon: [ax, top - ch - ah]});
      }
    }
    shapes.push({d});
    // Lit windows only, merged into one path per colour.
    for (let wy = top + 6; wy < HORIZON - 8; wy += stepY) {
      for (let wx = x + 4; wx < x + w - winW - 3; wx += stepX) {
        const p = rand();
        if (p < litCyan) cyan.push(`M${wx} ${wy}h${winW}v${winH}h-${winW}z`);
        else if (p < litCyan + lit) amber.push(`M${wx} ${wy}h${winW}v${winH}h-${winW}z`);
      }
    }
    x += w + gap;
  }
  return {body: shapes.filter((s) => s.d).map((s) => s.d).join(''), beacons: shapes.filter((s) => s.beacon).map((s) => s.beacon),
    amber: amber.join(''), cyan: cyan.join('')};
}

const far = layer({x0: 380, x1: W, minW: 22, maxW: 46, minH: 40, maxH: 120, gap: 2, lit: 0.05, litCyan: 0.02,
  winW: 2, winH: 3, stepX: 6, stepY: 8});
const mid = layer({x0: 470, x1: W, minW: 26, maxW: 58, minH: 50, maxH: 150, gap: 3, lit: 0.09, litCyan: 0.025,
  winW: 3, winH: 4, stepX: 8, stepY: 10, towers: [{at: 1010, h: 178}]});
const near = layer({x0: 560, x1: W, minW: 30, maxW: 70, minH: 30, maxH: 104, gap: 4, lit: 0.12, litCyan: 0.03,
  winW: 3, winH: 5, stepX: 9, stepY: 12, towers: [{at: 760, h: 150}]});

// Perspective floor: verticals converging on the vanishing point, horizontals compressing toward the horizon.
const vx = 900;
const grid = [];
for (let i = -26; i <= 26; i++) grid.push(`M${f(vx + i * 14)} ${HORIZON}L${f(vx + i * 150)} ${H}`);
for (let k = 1; k <= 9; k++) {
  const y = HORIZON + (H - HORIZON) * Math.pow(k / 9, 2.1);
  grid.push(`M0 ${f(y)}H${W}`);
}

// Rain: thin slanted strokes over the city only.
const rain = [];
for (let i = 0; i < 70; i++) {
  const x = r(420, W), y = r(20, HORIZON + 40), l = r(10, 26);
  rain.push(`M${f(x)} ${f(y)}l${f(-l * 0.22)} ${f(l)}`);
}

// Stars.
const stars = [];
for (let i = 0; i < 46; i++) stars.push(`<circle cx="${f(r(380, W - 20))}" cy="${f(r(18, 120))}" r="${f(r(0.5, 1.2))}"/>`);

// A faint column of hexadecimal on the right edge: generic x86 prologue/epilogue bytes, the kind every compiled function starts and ends with.
const hexRows = ['55 8B EC 6A FF', '68 00 00 00 00', '64 A1 00 00 00', '50 64 89 25 00', '83 EC 10 53 56', '57 89 65 F0 8B',
  'D9 45 08 D8 4D', 'D9 5D FC 8B 45', '5F 5E 5B 8B E5', '5D C2 04 00 CC'];
const hex = hexRows.map((row, i) => `<text x="${W - 34}" y="${48 + i * 15}">${row}</text>`).join('');

const beacons = [...mid.beacons, ...near.beacons].map(([x, y]) =>
  `<circle cx="${x}" cy="${y - 2}" r="6" fill="#ff4d4d" opacity=".25"/><circle cx="${x}" cy="${y - 2}" r="2" fill="#ff6b5e"/>`).join('');

const corner = (x, y, sx, sy) => `M${x} ${y + sy * 22}V${y}H${x + sx * 22}`;
const brackets = [corner(14, 14, 1, 1), corner(W - 14, 14, -1, 1), corner(14, H - 14, 1, -1), corner(W - 14, H - 14, -1, -1)].join('');

const sans = `'Inter','Segoe UI','Helvetica Neue',Helvetica,Arial,sans-serif`;
const mono = `ui-monospace,'SFMono-Regular','JetBrains Mono',Menlo,Consolas,'DejaVu Sans Mono',monospace`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d">
<title id="t">deus_ex_web</title>
<desc id="d">An original illustration: a night skyline over a perspective grid, framed by thin interface brackets, with the project name and the path from UnrealScript bytecode and x86 native code to Rust, WebAssembly and WebGL2.</desc>
<defs>
<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#03060b"/><stop offset=".62" stop-color="#081524"/><stop offset=".77" stop-color="#0d2236"/><stop offset="1" stop-color="#050b13"/></linearGradient>
<radialGradient id="halo" cx=".7" cy=".78" r=".55"><stop offset="0" stop-color="#1fb6e8" stop-opacity=".30"/><stop offset=".45" stop-color="#1a6f9e" stop-opacity=".10"/><stop offset="1" stop-color="#1a6f9e" stop-opacity="0"/></radialGradient>
<linearGradient id="fadeL" x1="0" y1="0" x2="1" y2="0"><stop offset=".30" stop-color="#fff" stop-opacity="0"/><stop offset=".56" stop-color="#fff" stop-opacity="1"/></linearGradient>
<mask id="city"><rect width="${W}" height="${H}" fill="url(#fadeL)"/></mask>
<linearGradient id="floorFade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".9"/><stop offset="1" stop-color="#fff" stop-opacity=".15"/></linearGradient>
<mask id="floor"><rect y="${HORIZON}" width="${W}" height="${H - HORIZON}" fill="url(#floorFade)"/></mask>
<pattern id="scan" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="1" fill="#000" opacity=".28"/></pattern>
<filter id="glow" x="-10%" y="-40%" width="120%" height="180%"><feGaussianBlur stdDeviation="4" result="b"/><feComponentTransfer in="b" result="g"><feFuncA type="linear" slope=".75"/></feComponentTransfer><feMerge><feMergeNode in="g"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
<filter id="soft" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="1.1" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
</defs>
<rect width="${W}" height="${H}" fill="url(#sky)"/>
<rect width="${W}" height="${H}" fill="url(#halo)"/>
<g mask="url(#city)">
<g fill="#cfe9ff" opacity=".55">${stars.join('')}</g>
<path d="${far.body}" fill="#10233a"/>
<path d="${far.amber}" fill="#e9a93c" opacity=".45"/><path d="${far.cyan}" fill="#6fd6ff" opacity=".45"/>
<path d="${mid.body}" fill="#0b1a2c"/>
<path d="${mid.amber}" fill="#f0b040" opacity=".7" filter="url(#soft)"/><path d="${mid.cyan}" fill="#73dbff" opacity=".7" filter="url(#soft)"/>
<path d="${near.body}" fill="#060e18"/>
<path d="${near.amber}" fill="#f7bd4a" opacity=".85" filter="url(#soft)"/><path d="${near.cyan}" fill="#7fe0ff" opacity=".8" filter="url(#soft)"/>
${beacons}
<path d="${rain.join('')}" stroke="#9fd8ff" stroke-width=".7" opacity=".16"/>
</g>
<rect y="${HORIZON - 1}" width="${W}" height="2" fill="#3fc8f4" opacity=".55" filter="url(#glow)"/>
<g mask="url(#floor)"><path d="${grid.join('')}" stroke="#2bb8e8" stroke-width="1" opacity=".45" fill="none"/></g>
<g font-family="${mono}" font-size="10" fill="#4fc3ea" opacity=".22" text-anchor="end">${hex}</g>
<g font-family="${sans}">
<text x="64" y="94" font-size="14" letter-spacing="4" textLength="462" lengthAdjust="spacing" fill="#5fd0f5" opacity=".9">INDEPENDENT · FAITHFUL · IN THE BROWSER</text>
<text x="60" y="170" font-family="${mono}" font-size="76" font-weight="700" textLength="500" lengthAdjust="spacing" fill="#e9f7ff" filter="url(#glow)">deus_ex_web</text>
<rect x="574" y="116" width="22" height="54" fill="#3fc8f4" opacity=".85" filter="url(#glow)"/>
<text x="64" y="212" font-family="${mono}" font-size="17" textLength="500" lengthAdjust="spacing" fill="#a9c7da">UnrealScript · x86 → <tspan fill="#f2b33d">Rust</tspan> → <tspan fill="#f2b33d">WebAssembly</tspan> → <tspan fill="#f2b33d">WebGL2</tspan></text>
</g>
<rect x="64" y="110" width="56" height="2" fill="#3fc8f4" opacity=".8"/>
<path d="${brackets}" stroke="#3fc8f4" stroke-width="2" fill="none" opacity=".75"/>
<rect width="${W}" height="${H}" fill="url(#scan)"/>
</svg>
`;
writeFileSync(process.argv[2] ?? new URL('../docs/readme/banner.svg', import.meta.url), svg);
console.log(`${svg.length} bytes`);
