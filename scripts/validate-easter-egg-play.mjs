/**
 * The opt-in ?easter=1 mod in Play's default worker mode (docs/easter-egg.md). Not original-game behavior: it checks that the mod
 * does what it says and, without the flag, nothing at all.
 *
 * With ?easter=1 on 10_Paris_Club:
 *  - both actors exist at their places (easter-config.mjs place) as the stock classes: Female1 (GFM_TShirtPants) sitting through the
 *    original ScriptedPawn.Sitting state on the hidden stock Chair1 over a CrateBreakableMedGeneral, and Businessman2 (GM_Suit)
 *    in the original Standing state; the HUD names are the pawns' own FamiliarName/UnfamiliarName; the crate is wooden;
 *  - their skins are generated: every recipe's skin was asked for by the page's mesh draw and its pixels are the colours the design
 *    names (purple hoodie, olive trousers, olive jacket, golden hair and ponytail);
 *  - a real right-click on each (the original RightMouse binding, FrobTarget on the pawn) shows its line in the original HUD log
 *    and the other's answer follows after replyDelay;
 *  - they stay put: neither pawn moves, changes state or loses health through the frobs.
 * Without the flag (a second page): no mod state, no skin hook, none of the mod's actors among the actor mesh bindings.
 *
 *   node scripts/validate-easter-egg-play.mjs [--url http://127.0.0.1:5173] [--angle gl] [--shots DIR]
 *
 * --shots DIR also writes the screenshots (wide view and a close-up of each, default settings, HUD on).
 * The equivalence with a build without the mod is validate-sim-split.mjs on this map (docs/easter-egg.md "Verification").
 */
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';
import {EASTER} from '../src/viewer/easter-config.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP validate-easter-egg-play: no installed game data'); process.exit(0); }
const angle = option('angle', process.platform === 'darwin' ? 'metal' : 'gl'), shots = option('shots', null);
let server = null, base = option('url', null);
if (!base) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const {default: config} = await import('../vite.config.mjs');
  const deny = config.server.fs.deny.filter(pattern => !(pattern.includes('.work') && root.includes('/.work/'))
    && !(pattern.includes('.claude/worktrees') && root.includes('/.claude/worktrees/')));
  server = await createServer({...config, configFile: false, root, logLevel: 'error',
    server: {...config.server, port: 0, strictPort: false, fs: {...config.server.fs, deny}, watch: null}});
  await server.listen();
  base = server.resolvedUrls.local[0].replace(/\/$/, '');
}

async function open(browser, query) {
  const page = await browser.newPage({viewport: {width: 1440, height: 900}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { try { localStorage.setItem('deusex.uiHidden', '1'); } catch { /* storage unavailable */ } });
  const target = new URL(base);
  for (const [key, value] of Object.entries(query)) target.searchParams.set(key, value);
  await page.goto(target.href);
  await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 240000});
  await page.evaluate(map => { const menu = document.getElementById('map'); menu.value = map; menu.dispatchEvent(new Event('change')); }, EASTER.map);
  await page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && s.map === map && s.mode === 'play'; }, EASTER.map, {timeout: 240000});
  return {page, errors};
}
const status = page => page.evaluate(() => window.deusExViewer.easterProbe({op: 'status'}));
async function until(page, what, test, seconds = 40) {
  const end = Date.now() + seconds * 1000;
  for (let last; Date.now() < end; await page.waitForTimeout(250)) { last = await status(page); if (await test(last)) return last; }
  throw new Error(`timed out waiting for ${what}`);
}
const near = (a, b, tolerance, what) => assert.ok(Math.abs(a - b) <= tolerance, `${what}: ${a}, expected ${b}`);

const browser = await chromium.launch({args: [`--use-angle=${angle}`, '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader']});
try {
  // 1. ?easter=1
  {
    const {page, errors} = await open(browser, {easter: '1'});
    const s = await until(page, 'both actors settled', s => s.active && s.claudia?.state === 'Sitting' && s.claudia.anim === 'SitBreathe' && s.rydgel?.state === 'Standing');
    const {place, claudia, rydgel} = EASTER;
    // Claudia: the stock Female1 on the original Sitting state, on the hidden seat over the crate.
    assert.equal(s.claudia.className, 'deusex.female1');
    assert.equal(s.claudia.mesh, 'GFM_TShirtPants');
    assert.equal(s.claudia.orders, 'Sitting');
    assert.equal(s.claudia.sitting, true);
    assert.equal(s.claudia.seat, s.seat.name);
    assert.equal(s.seat.hidden, true);
    near(s.claudia.location[0], place.crate.x, 0.5, 'Claudia x'); near(s.claudia.location[1], place.crate.y, 0.5, 'Claudia y');
    assert.ok(s.claudia.location[2] > place.floor + 48 && s.claudia.location[2] < place.floor + 110, `Claudia sits above the crate lid (z ${s.claudia.location[2]})`);
    assert.equal(s.claudia.conList, null, 'no original conversation list: a frob reaches only the mod\'s line'); assert.equal(s.rydgel.conList, null);
    assert.equal(s.claudia.familiar, claudia.name); assert.equal(s.claudia.unfamiliar, claudia.name);
    assert.deepEqual(s.claudia.multiSkins.slice(3, 5), ['FramesTex1', 'LensesTex2'], 'the stock glasses slots are on');
    // The crate: wooden, set down on the floor at its place.
    assert.equal(s.crate.name.replace(/\d+$/, ''), 'CrateBreakableMedGeneral');
    near(s.crate.location[0], place.crate.x, 0.5, 'crate x'); near(s.crate.location[1], place.crate.y, 0.5, 'crate y'); near(s.crate.location[2], place.floor + 24, 1, 'crate z');
    // Rydgel: the stock Businessman2, Standing, at the bar.
    assert.equal(s.rydgel.className, 'deusex.businessman2');
    assert.equal(s.rydgel.mesh, 'GM_Suit');
    assert.equal(s.rydgel.orders, 'Standing');
    near(s.rydgel.location[0], place.rydgel.x, 0.5, 'Rydgel x'); near(s.rydgel.location[1], place.rydgel.y, 0.5, 'Rydgel y');
    near(s.rydgel.location[2], place.floor + 47.5, 1.5, 'Rydgel z');
    assert.equal(s.rydgel.familiar, rydgel.name); assert.equal(s.rydgel.unfamiliar, rydgel.name);
    assert.equal(s.rydgel.multiSkins[7], 'PonytailTex1');
    console.log(`PASS actors: ${s.claudia.name} (${s.claudia.className}, ${s.claudia.anim}) and ${s.rydgel.name} (${s.rydgel.className}, ${s.rydgel.anim}) on ${s.crate.name}`);

    // Skins: every recipe was asked for by the mesh draw; the pixels carry the design's colours.
    const skins = await page.evaluate(async () => {
      const {easterSkins} = await import('/src/viewer/easter-skins.mjs');
      const made = easterSkins.current?.generated;
      if (!made) return null;
      const hue = (r, g, b) => { const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; if (!d) return null;
        const h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return {h: h * 60, s: d / mx, v: mx / 255}; };
      return [...made].map(([key, data]) => {
        let x = 0, y = 0, n = 0;
        const m = data.mips[0];
        for (let i = 0; i < m.data.length; i += 4) {
          if (m.data[i + 3] < 128) continue;
          const c = hue(m.data[i], m.data[i + 1], m.data[i + 2]);
          if (!c || c.s < 0.2 || c.v < 0.15) continue;
          x += Math.cos(c.h * Math.PI / 180); y += Math.sin(c.h * Math.PI / 180); n++;
        }
        return {key, size: [m.width, m.height], mips: data.mips.length, opaque: n, hue: n ? (Math.atan2(y, x) * 180 / Math.PI + 360) % 360 : null};
      });
    });
    assert.ok(skins, 'the page registered the mod\'s skin hook');
    const find = (who, suffix) => skins.filter(skin => skin.key.startsWith(`easter:${who}:`) && skin.key.toLowerCase().includes(`.${suffix}:`));
    const expected = [['claudia', 'female1tex1', [255, 295], 'purple hoodie'], ['claudia', 'pantstex2', [60, 100], 'olive trousers'],
      ['rydgel', 'businessman2tex1', [70, 105], 'olive jacket'], ['rydgel', 'ponytailtex1', [38, 52], 'golden ponytail'],
      ['rydgel', 'businessman2tex0', [20, 50], 'golden hair on the head skin']];
    for (const [who, suffix, [low, high], what] of expected) {
      const found = find(who, suffix);
      assert.ok(found.length, `${what}: no ${who} ${suffix} skin was drawn`);
      for (const skin of found) { assert.ok(skin.mips >= 7, `${skin.key} has its mip chain`); assert.ok(skin.hue >= low && skin.hue <= high, `${what}: ${skin.key} hue ${skin.hue?.toFixed(0)} outside ${low}-${high}`); }
    }
    for (const [who, suffix] of [['claudia', 'female1tex0'], ['claudia', 'framestex1'], ['rydgel', 'businessman2tex2']]) assert.ok(find(who, suffix).length, `${who} ${suffix} skin drawn`);
    console.log(`PASS skins: ${skins.length} generated (${skins.map(skin => skin.key.replace(/^easter:|DeusExCharacters\.Skins\./g, '')).join(', ')})`);

    // Frob: the original RightMouse binding on each, then the other's answer.
    const place_ = async (location, yaw) => { await page.evaluate(args => window.deusExViewer.viewProbe(args), {location, rotation: [0, yaw, 0]}); };
    const aim = {claudia: [[place.crate.x + 50, place.crate.y, place.floor + 43], 32768], rydgel: [[place.rydgel.x + 45, place.rydgel.y, place.floor + 43], 32768]};
    const before = {claudia: s.claudia, rydgel: s.rydgel};
    await mkdir(shots ?? '.', {recursive: true});
    if (shots) {
      await place_([-960, -420, -132.5], 32768);
      await page.waitForTimeout(2500);
      await page.screenshot({path: `${shots}/easter-wide.png`});
    }
    for (const who of ['claudia', 'rydgel']) {
      const other = who === 'claudia' ? 'rydgel' : 'claudia', pairs = EASTER.pairs[who];
      await place_(...aim[who]);
      const target = await until(page, `${who} as FrobTarget`, t => t.frobTarget === before[who].name, 15);
      if (shots) { await page.waitForTimeout(1200); await page.screenshot({path: `${shots}/easter-${who}.png`}); }
      const lines = target.log.length;
      await page.mouse.move(720, 450);
      await page.mouse.click(720, 450, {button: 'right'});
      const said = await until(page, `${who}'s frob line`, t => t.log.length > lines, 10);
      assert.equal(said.log[lines], `${EASTER[who].name}: ${pairs[0][0]}`, `${who}'s first line`);
      assert.equal(said.log.length, lines + 1, 'the answer is not instant');
      const answered = await until(page, `${other}'s answer`, t => t.log.length > lines + 1, 10);
      assert.equal(answered.log[lines + 1], `${EASTER[other].name}: ${pairs[0][1]}`, `${other}'s answer`);
      if (shots && who === 'claudia') { await page.waitForTimeout(500); await page.screenshot({path: `${shots}/easter-claudia-frob.png`}); }
      console.log(`PASS frob ${who}: "${said.log[lines]}" then "${answered.log[lines + 1]}"`);
    }
    // A second frob of Claudia takes her next line.
    {
      await place_(...aim.claudia);
      const t = await until(page, 'Claudia as FrobTarget again', t => t.frobTarget === before.claudia.name, 15), lines = t.log.length;
      await page.mouse.click(720, 450, {button: 'right'});
      const said = await until(page, 'second line', t => t.log.length > lines, 10);
      assert.equal(said.log[lines], `${EASTER.claudia.name}: ${EASTER.pairs.claudia[1][0]}`);
      await until(page, 'second answer', t => t.log.length > lines + 1, 10);
    }
    // They stayed put: same place, same state, same health, no error.
    const after = await status(page);
    for (const who of ['claudia', 'rydgel']) {
      assert.deepEqual(after[who].location, before[who].location, `${who} did not move`);
      assert.equal(after[who].state, before[who].state, `${who} kept its state`);
      assert.equal(after[who].health, before[who].health);
      assert.equal(after[who].invincible, true);
    }
    console.log('PASS stay put: positions, states and health unchanged through the frobs');
    // A Player start (the page's Reset) reloads the level: the mod places them again, on the new generation, and frobs still work.
    await page.evaluate(() => document.getElementById('reset').click());
    const again = await until(page, 'both actors again after Reset', s => s.active && s.time < after.time && s.claudia?.state === 'Sitting' && s.rydgel?.state === 'Standing');
    assert.deepEqual(again.claudia.location, before.claudia.location);
    assert.deepEqual(again.log, [], 'a fresh player log');
    await place_(...aim.rydgel);
    await until(page, 'Rydgel as FrobTarget after Reset', t => t.frobTarget === again.rydgel.name, 15);
    await page.mouse.click(720, 450, {button: 'right'});
    const reset = await until(page, 'a frob line after Reset', t => t.log.length > 0, 10);
    assert.equal(reset.log[0], `${EASTER.rydgel.name}: ${EASTER.pairs.rydgel[0][0]}`, 'the speaker rotation starts again');
    assert.deepEqual(errors, [], 'no page error');
    console.log('PASS Reset: placed again on the new level, frob and rotation restart');
    await page.close();
  }

  // 2. Without the flag: nothing.
  {
    const {page, errors} = await open(browser, {});
    await page.waitForTimeout(8000);
    const s = await status(page);
    assert.equal(s.active, false, 'no mod state');
    const hook = await page.evaluate(async () => (await import('/src/viewer/easter-skins.mjs')).easterSkins.current);
    assert.equal(hook, null, 'no skin hook');
    const bindings = await page.evaluate(() => window.deusExViewer.lodProbe({list: true}));
    const names = JSON.stringify(bindings);
    for (const name of ['CrateBreakableMedGeneral2', 'Chair4', 'Female2', 'Businessman1']) assert.ok(!names.includes(`"${name}"`), `${name} is not among the mesh bindings`);
    assert.deepEqual(errors, [], 'no page error');
    console.log('PASS off: no mod state, no skin hook, none of the mod\'s actors');
    await page.close();
  }
} finally {
  await browser.close();
  await server?.close();
}
