/**
 * The opt-in ?easter=1 mod in Play's default worker mode (docs/easter-egg.md). Not original-game behavior: it checks that the mod
 * does what it says and, without the flag, nothing at all.
 *
 * With ?easter=1 on 10_Paris_Club:
 *  - both actors exist at their places (easter-config.mjs place) as the stock classes: Female1 (GFM_TShirtPants) sitting through the
 *    original ScriptedPawn.Sitting state on the hidden stock Chair1 over a CrateBreakableMedGeneral, and Rydgel's stock class (the look
 *    in easter-config.mjs: FordSchick on GM_Trench, or Businessman2 on GM_Suit) in the original Standing state; the HUD names are the pawns' own FamiliarName/UnfamiliarName; the crate is wooden;
 *  - their skins are generated: every recipe's skin was asked for by the page's mesh draw and its pixels are the colours the design
 *    names (purple hoodie, olive trousers, olive jacket over a plain dark tee, golden loose hair, no ponytail);
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
import {EASTER, RYDGEL_LOOKS} from '../src/viewer/easter-config.mjs';

// Rydgel's look is one setting in easter-config.mjs ('trench' or 'suit'); the checks follow it.
const look = RYDGEL_LOOKS[EASTER.rydgel.look], modNames = [];

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
    near(s.claudia.location[0], place.crate.x + 34 - place.heelForward + place.heelClearance, 0.5, 'Claudia x'); near(s.claudia.location[1], place.crate.y, 0.5, 'Claudia y');
    assert.ok(s.claudia.location[2] > place.floor + 48 && s.claudia.location[2] < place.floor + 110, `Claudia sits above the crate lid (z ${s.claudia.location[2]})`);
    // No float and no clipping (docs/easter-egg.md "Her seat"): the pose's seat plane (the mesh origin Location + PrePivot, hipDrop below it)
    // lies on the crate's top surface, the heels are in front of its front face and the back of the hips is still over the lid.
    const lidTop = s.crate.location[2] + s.crate.collisionHeight, seatPlane = s.claudia.location[2] + s.claudia.prePivot[2] - place.hipDrop;
    near(seatPlane, lidTop - place.lidEmbed, 0.15, 'the pose\'s seat plane meets the crate lid');
    // Along the room axis (+x; the pose's forward distances are place.*Forward): the front face, the hips and thighs on the lid, the backs of the knees
    // just past the edge, the shins (heels and ankles, the rearmost points of the lower leg) in front of the face.
    const face = s.crate.location[0] + s.crate.collisionRadius, hipX = s.claudia.location[0] - place.hipBack, kneeX = s.claudia.location[0] + place.kneeBackForward;
    assert.ok(hipX >= s.crate.location[0] - s.crate.collisionRadius, 'the back of her hips is over the lid');
    assert.ok(face - hipX >= 0.7 * (place.hipBack + place.kneeBackForward), `her thighs rest on the lid: ${(face - hipX).toFixed(1)} of ${place.hipBack + place.kneeBackForward} units`);
    assert.ok(kneeX >= face && kneeX - face <= 8, `the backs of her knees are at the front edge, a few units past it: ${(kneeX - face).toFixed(1)}`);
    assert.ok(s.claudia.location[0] + place.heelForward >= face + 0.5 && s.claudia.location[0] + place.ankleForward >= face + 0.5, 'her shins hang clear of the crate\'s front face');
    assert.equal(s.claudia.drawScale, 1);
    assert.equal(s.claudia.conList, null, 'no original conversation list: a frob reaches only the mod\'s line'); assert.equal(s.rydgel.conList, null);
    assert.equal(s.claudia.familiar, claudia.name); assert.equal(s.claudia.unfamiliar, claudia.name);
    assert.deepEqual(s.claudia.multiSkins.slice(3, 5), ['FramesTex1', 'LensesTex2'], 'the stock glasses slots are on');
    // The crate: wooden, set down on the floor at its place.
    assert.equal(s.crate.name.replace(/\d+$/, ''), 'CrateBreakableMedGeneral');
    near(s.crate.location[0], place.crate.x, 0.5, 'crate x'); near(s.crate.location[1], place.crate.y, 0.5, 'crate y'); near(s.crate.location[2], place.floor + 24, 1, 'crate z');
    // Rydgel: the look's stock class, Standing, at the bar.
    assert.equal(s.rydgel.className, `deusex.${look.pawnClass.toLowerCase()}`);
    assert.equal(s.rydgel.mesh, look.mesh);
    modNames.push(s.crate.name, s.seat.name, s.claudia.name, s.rydgel.name);
    assert.equal(s.rydgel.orders, 'Standing');
    near(s.rydgel.location[0], place.rydgel.x, 0.5, 'Rydgel x'); near(s.rydgel.location[1], place.rydgel.y, 0.5, 'Rydgel y');
    near(s.rydgel.location[2], place.floor + 47.5, 1.5, 'Rydgel z');
    assert.equal(s.rydgel.familiar, rydgel.name); assert.equal(s.rydgel.unfamiliar, rydgel.name);
    // No ponytail: the unused parts (GM_Suit's ponytail in slot 7, the glasses) keep the class's own stock mask textures (the game hides
    // unused parts this way); the mod writes none of Rydgel's slots.
    assert.equal(s.rydgel.multiSkins[7], s.defaultSkins.rydgel[7], 'slot 7 is the class\'s own');
    assert.match(s.rydgel.multiSkins[7], /MaskTex$/, 'the last slot holds a stock mask texture');
    assert.deepEqual(s.rydgel.multiSkins.slice(8 - look.maskTail.length), look.maskTail);
    assert.deepEqual(s.rydgel.multiSkins, s.defaultSkins.rydgel, 'the class\'s MultiSkins are untouched');
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
      ['rydgel', (look.textures.jacket ?? look.textures.coat).toLowerCase(), [70, 105], 'olive jacket'],
      ['rydgel', look.textures.head.toLowerCase(), [20, 50], 'golden hair on the head skin']];
    for (const [who, suffix, [low, high], what] of expected) {
      const found = find(who, suffix);
      assert.ok(found.length, `${what}: no ${who} ${suffix} skin was drawn`);
      for (const skin of found) { assert.ok(skin.mips >= 7, `${skin.key} has its mip chain`); assert.ok(skin.hue >= low && skin.hue <= high, `${what}: ${skin.key} hue ${skin.hue?.toFixed(0)} outside ${low}-${high}`); }
    }
    assert.equal(find('rydgel', 'ponytailtex1').length, 0, 'no ponytail skin is drawn');
    // Rydgel's tee. Suit look (Businessman2Tex1's front): the opening is a plain dark brown-black jersey (no tie: no bright column, no
    // mid-tone pattern), the lapel zone, the overlap and the buttons are flattened cloth (a narrow spread of brightness), a zip runs down
    // and there is no chest patch. Trench look (the undershirt FordSchickTex1): the whole shirt is dark brown-black jersey, the gold chains
    // and the pendant are drawn on it.
    const tee = await page.evaluate(async role => {
      const {easterSkins} = await import('/src/viewer/easter-skins.mjs');
      const data = [...easterSkins.current.generated].find(([key]) => key.startsWith('easter:rydgel:') && key.includes(role) && key.endsWith(':false'))?.[1];
      if (!data) return null;
      const m = data.mips[0], at = (u, v) => { const i = (Math.floor(v * m.height) * m.width + Math.floor(u * m.width)) * 4; return [m.data[i], m.data[i + 1], m.data[i + 2], m.data[i + 3]]; };
      const value = ([r, g, b]) => Math.max(r, g, b) / 255, gold = (u, v, [r, g, b]) => r > 150 && r > b * 1.6, stats = (box, skip) => {
        const values = [];
        for (let v = box[1]; v < box[3]; v += 1 / m.height) for (let u = box[0]; u < box[2]; u += 1 / m.width) { const px = at(u, v); if (px[3] && !(skip && skip(u, v, px))) values.push(value(px)); }
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        return {n: values.length, mean, max: Math.max(...values), min: Math.min(...values), spread: Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length)};
      };
      const count = (box, test) => { let n = 0; for (let v = box[1]; v < box[3]; v += 1 / m.height) for (let u = box[0]; u < box[2]; u += 1 / m.width) { const px = at(u, v); if (px[3] && test(u, v, px)) n++; } return n; };
      return {
        // suit: inside the opening away from the chains and the pendant; the stock lapel notch and band left of it; the overlap and button
        // zone below it, away from the zip; the zip; where the chest patch (a gold ring) was
        opening: stats([0.797, 0.235, 0.855, 0.32], (u, v, px) => gold(u, v, px)),
        lapel: stats([0.747, 0.08, 0.758, 0.34]),
        overlap: stats([0.75, 0.42, 0.91, 0.63], (u) => Math.abs(u - 0.8267) < 0.012),
        zip: stats([0.8227, 0.4, 0.8307, 0.63]),
        patch: count([0.855, 0.16, 0.915, 0.27], (u, v, px) => gold(u, v, px)),
        // trench: the shirt's torso panel (away from its gold) and the gold of its chains
        shirt: stats([0.22, 0.34, 0.78, 0.9], (u, v, px) => gold(u, v, px)),
        chains: count([0.2, 0.08, 0.8, 0.34], (u, v, px) => gold(u, v, px)),
      };
    }, look.textures.jacket ?? look.textures.shirt);
    assert.ok(tee, 'the jacket or shirt skin was drawn');
    if (look.textures.jacket) {
      assert.ok(tee.opening.max < 0.2 && tee.opening.spread < 0.03, 'the tee opening is a plain dark jersey: ' + JSON.stringify(tee.opening));
      assert.ok(tee.lapel.spread < 0.07 && tee.lapel.min > 0.3, 'the lapel zone is flat cloth: ' + JSON.stringify(tee.lapel));
      assert.ok(tee.overlap.spread < 0.08 && tee.overlap.min > 0.27, 'the double-breasted overlap and its buttons are gone: ' + JSON.stringify(tee.overlap));
      assert.ok(tee.zip.min < 0.2 && tee.zip.max > 0.5, 'a zip runs down the front: ' + JSON.stringify(tee.zip));
      assert.equal(tee.patch, 0, 'no chest patch (no gold ring)');
      console.log('PASS tee (suit): opening ' + JSON.stringify(tee.opening) + ', lapel spread ' + tee.lapel.spread.toFixed(3) + ', overlap spread ' + tee.overlap.spread.toFixed(3) + ', no patch');
    } else {
      assert.ok(tee.shirt.max < 0.25 && tee.shirt.mean < 0.16, 'the undershirt is a dark brown-black jersey: ' + JSON.stringify(tee.shirt));
      assert.ok(tee.chains > 25, 'the gold chains and pendant are drawn on the shirt: ' + tee.chains);
      console.log('PASS tee (trench): shirt ' + JSON.stringify(tee.shirt) + ', gold texels ' + tee.chains);
    }
    for (const [who, suffix] of [['claudia', 'female1tex0'], ['claudia', 'framestex1'], ['rydgel', look.textures.trousers.toLowerCase()]]) assert.ok(find(who, suffix).length, `${who} ${suffix} skin drawn`);
    console.log(`PASS skins: ${skins.length} generated (${skins.map(skin => skin.key.replace(/^easter:|DeusExCharacters\.Skins\./g, '')).join(', ')})`);

    // Frob: the original RightMouse binding on each. The speaker's line shows in the HUD log as its clip starts and the clip plays as the
    // speaker's speech through the game's own path (Actor.PlaySound -> Galaxy channel -> the host decode -> the ring voice, then the lip-sync
    // analysis writes the speaker's nextPhoneme and the original Pawn.LipSynch tweens its Mouth* blend animation); the other's answer and clip
    // follow after the line's clip has ended.
    const place_ = async (location, yaw, pitch = 0) => { await page.evaluate(args => window.deusExViewer.viewProbe(args), {location, rotation: [pitch, yaw, 0]}); };
    const aim = {claudia: [[place.crate.x + 66, place.crate.y, place.floor + 43], 32768, -4000], rydgel: [[place.rydgel.x + 45, place.rydgel.y, place.floor + 43], 32768, 0]};
    const faceView = {claudia: [aim.claudia[0], 32768, -300], rydgel: [aim.rydgel[0], 32768, -300]};
    const before = {claudia: s.claudia, rydgel: s.rydgel};
    const mouthOf = actor => actor.speech.blend[0] ?? 'None', idle = mouth => mouth === 'None' || mouth === '' || mouth === 'MouthClosed';
    await mkdir(shots ?? '.', {recursive: true});
    if (shots) {
      await place_([-960, -420, -132.5], 32768);
      await page.waitForTimeout(2500);
      await page.screenshot({path: `${shots}/easter-wide.png`});
    }
    // Without a clip nothing moves their mouths: they idle for 1.5 s with no blend animation, no letter, no speaking flag.
    {
      assert.equal(s.voice.available, true, `the clips loaded (${s.voice.error})`);
      for (let i = 0; i < 6; i++) {
        const t = await status(page);
        for (const who of ['claudia', 'rydgel']) {
          assert.ok(!t[who].speech.speaking && !t[who].speech.wasSpeaking && t[who].speech.nextPhoneme === '' && idle(mouthOf(t[who])) && mouthOf(t[who]) !== 'MouthClosed', `${who}'s mouth is still without a clip: ${JSON.stringify(t[who].speech)}`);
        }
        assert.deepEqual(t.voice.log, []);
        await page.waitForTimeout(250);
      }
      console.log('PASS no clip, no mouth: nextPhoneme empty, no Mouth* blend animation, bIsSpeaking clear (6 samples over 1.5 s)');
    }
    const exchange = async (who, index, {shotsFor = null, clickTwice = false} = {}) => {
      const other = who === 'claudia' ? 'rydgel' : 'claudia', pairs = EASTER.pairs[who];
      await place_(...aim[who]);
      const target = await until(page, `${who} as FrobTarget`, t => t.frobTarget === before[who].name && !t.voice.busy, 20);
      if (shots && index === 0) { await page.waitForTimeout(800); await page.screenshot({path: `${shots}/easter-${who}.png`}); }
      const lines = target.log.length, logLength = target.voice.log.length;
      await page.mouse.move(720, 450);
      await page.mouse.click(720, 450, {button: 'right'});
      const samples = [], captured = {claudia: [], rydgel: []};
      let clicked = false;
      const end = Date.now() + 40000;
      for (;;) {
        const t = await status(page);
        samples.push({at: Date.now(), t});
        if (t.voice.log.length >= logLength + 2) break;
        assert.ok(Date.now() < end, `the exchange did not finish: ${JSON.stringify(t.voice)}`);
        const speaker = t.voice.current?.speaker;
        if (clickTwice && !clicked && speaker === who) { clicked = true; await page.mouse.click(720, 450, {button: 'right'}); }
        // two screenshots per speaker mid-word, with different mouth shapes
        if (shotsFor && speaker && shotsFor.includes(speaker)) {
          const mouth = mouthOf(t[speaker]);
          if (!idle(mouth) && captured[speaker].length < 2 && !captured[speaker].includes(mouth)) {
            if (captured[speaker].length === 0 || Date.now() - captured[speaker].at > 400) {
              await place_(...faceView[speaker]);
              captured[speaker].push(mouth); captured[speaker].at = Date.now();
              await page.waitForTimeout(150);
              await page.screenshot({path: `${shots}/easter-${speaker}-midword-${captured[speaker].length}-${mouth}.png`});
            }
          }
        }
        await page.waitForTimeout(80);
      }
      const done = samples.at(-1).t, [line, answer] = done.voice.log.slice(logLength);
      // The clips: the frobbed one's line, then the other's answer, both through the speech path (a Galaxy channel held each) with no error.
      assert.equal(line.id, `frob-${who}-${index}`); assert.equal(line.speaker, who);
      assert.equal(answer.id, `reply-${who}-${index}`); assert.equal(answer.speaker, other);
      for (const clip of [line, answer]) {
        assert.ok(clip.seen && clip.error === null, `${clip.id} played on a Galaxy channel: ${JSON.stringify(clip)}`);
        assert.ok(clip.seconds >= clip.length && clip.seconds <= clip.length + 3, `${clip.id} lasted ${clip.seconds} s for a ${clip.length} s clip`);
        // the speaker's mouth changed while it played: several letters and several Mouth* sequences
        const mouths = new Set(clip.mouths.filter(mouth => mouth.startsWith('Mouth') && mouth !== 'MouthClosed'));
        assert.ok(new Set(clip.letters).size >= 2 && mouths.size >= 2, `${clip.id}: the lip sync moved the mouth (letters ${clip.letters}, mouths ${clip.mouths})`);
        assert.ok(clip.mouths.every(mouth => mouth.startsWith('Mouth')), `${clip.id} mouths are Mouth* sequences`);
      }
      // The HUD lines: the line as its clip starts, the answer as its clip starts, after the line's clip has ended and replyGap.
      assert.equal(line.logAtStart, lines + 1, 'the line shows as its clip starts');
      assert.equal(answer.logAtStart, lines + 2, 'the answer shows as its clip starts');
      assert.equal(done.log[lines], `${EASTER[who].name}: ${pairs[index][0]}`, `${who}'s line`);
      assert.equal(done.log[lines + 1], `${EASTER[other].name}: ${pairs[index][1]}`, `${other}'s answer`);
      assert.ok(answer.started - line.ended >= EASTER.replyGap - 0.05 && answer.started - line.ended <= EASTER.replyGap + 0.4, `the answer starts ${(answer.started - line.ended).toFixed(2)} s after the line's clip ended`);
      // While a clip played the other one's mouth did not move and its flags stayed clear; the log showed the answer only after the line's clip.
      for (const {t} of samples) {
        const speaker = t.voice.current?.speaker;
        if (speaker) {
          const silent = speaker === who ? other : who;
          assert.ok(!t[silent].speech.speaking && idle(mouthOf(t[silent])), `the one not speaking keeps still: ${JSON.stringify(t[silent].speech)}`);
          assert.equal(t.log.length, speaker === who ? lines + 1 : lines + 2, `HUD lines while ${t.voice.current.id} plays`);
        }
      }
      // Afterwards both flags are clear and the speakers' mouths closed (the closing tween).
      const closed = await until(page, 'mouths closed', t => !t.voice.busy && [who, other].every(name => !t[name].speech.speaking && mouthOf(t[name]) === 'MouthClosed'), 15);
      assert.equal(closed.voice.audio.failed, 0, 'no failed host decode');
      return {line, answer, lines, captured, clicked};
    };
    for (const who of ['claudia', 'rydgel']) {
      const r = await exchange(who, 0, {shotsFor: shots ? ['claudia', 'rydgel'] : null, clickTwice: who === 'claudia'});
      if (who === 'claudia') {
        // A frob during an exchange does nothing: no extra line, no extra clip, the rotation not advanced.
        assert.equal(r.clicked, true, 'the second click was made during Claudia\'s clip');
      }
      console.log(`PASS frob ${who}: "${r.line.id}" (${r.line.seconds} s, letters ${r.line.letters.join('')}, mouths ${[...new Set(r.line.mouths)].join(',')}) then "${r.answer.id}" (${r.answer.seconds} s, letters ${r.answer.letters.join('')}), answer ${(r.answer.started - r.line.ended).toFixed(2)} s after the line's clip`);
    }
    // A second frob of Claudia takes her next line (the click during the first exchange did not advance the rotation).
    {
      const r = await exchange('claudia', 1);
      assert.equal(r.line.id, 'frob-claudia-1');
      console.log('PASS second frob of Claudia: ' + r.line.id + ' then ' + r.answer.id);
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
    assert.deepEqual(again.voice.log, [], 'a fresh voice log');
    await place_(...aim.rydgel);
    await until(page, 'Rydgel as FrobTarget after Reset', t => t.frobTarget === again.rydgel.name, 15);
    await page.mouse.click(720, 450, {button: 'right'});
    const reset = await until(page, 'a frob line after Reset', t => t.log.length > 0, 10);
    assert.equal(reset.log[0], `${EASTER.rydgel.name}: ${EASTER.pairs.rydgel[0][0]}`, 'the speaker rotation starts again');
    await until(page, 'the clip plays after Reset', t => t.voice.log.length >= 1 || t.voice.current?.channel, 15);
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
    assert.equal(modNames.length, 4, 'the first page recorded the mod\'s actor names');
    for (const name of modNames) assert.ok(!names.includes(`"${name}"`), `${name} is not among the mesh bindings`);
    assert.deepEqual(errors, [], 'no page error');
    console.log('PASS off: no mod state, no skin hook, none of the mod\'s actors');
    await page.close();
  }
} finally {
  await browser.close();
  await server?.close();
}
