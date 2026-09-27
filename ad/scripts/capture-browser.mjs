// Captures the browser runtime for the promo: 1280x720 stills that pair with
// the original-game shots (same eye and rotator, see shot-plan.mjs) and
// 1920x1080 gameplay clips stepped by the virtual clock at exactly 30 fps.
//
//   node ad/scripts/capture-browser.mjs stills [mapFilter]
//   node ad/scripts/capture-browser.mjs clips [clipName...]
import {mkdirSync, rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {enableClock, loadMap, openViewer, setCamera, setSelect, shot, status, step} from './browser-lib.mjs';
import {maps} from './shot-plan.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '../captures/browser');
const GPU = ['--use-angle=metal', '--ignore-gpu-blocklist'];
const [what = 'stills', ...rest] = process.argv.slice(2);

async function waitFor(page, predicate, maxFrames, label) {
  for (let i = 0; i < maxFrames; i++) {
    if (await page.evaluate(predicate)) return i;
    await step(page, 1);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function stills(mapFilter = '') {
  mkdirSync(out, {recursive: true});
  for (const plan of maps.filter(m => !m.sequence && m.map.includes(mapFilter))) {
    const {browser, page, errors} = await openViewer({width: 1280, height: 720, args: GPU, onlyMap: plan.map});
    try {
      await page.waitForFunction(() => {
        const s = window.deusExViewer.status();
        return s.mode !== 'play' || s.gameplay?.player?.grounded;
      }, null, {timeout: 120000}).catch(() => {});
      await enableClock(page);
      const s = await status(page);
      console.log(plan.map, 'mode', s.mode, s.runtimeError ?? '');
      for (const start of plan.start ?? []) {
        if (s.mode !== 'play') break;
        if (start.velocity) {
          // The original shot nudged JC forward; walk into the same DataLinkTrigger.
          await page.keyboard.down('KeyW');
          await step(page, 12);
          await page.keyboard.up('KeyW');
        }
        await step(page, Math.round((start.wait ?? 1000) / 1000 * 30));
        await shot(page, path.join(out, `${start.name}.png`));
        console.log(start.name, JSON.stringify((await status(page)).position));
      }
      for (const view of plan.shots ?? []) {
        await setCamera(page, view.eye, view.rotation);
        await step(page, 2);
        await shot(page, path.join(out, `${view.name}.png`));
        console.log(view.name);
      }
    } finally {
      if (errors.length) console.log('page errors:', errors.slice(0, 5));
      await browser.close();
    }
  }
}

// Gameplay clips: each returns after writing frames into captures/browser/clips/<name>/.
const clips = {
  // Spawn → Jaime's InfoLink → walk to the first door → use it → walk through.
  async walk(page, frame) {
    await frame(20);
    await page.keyboard.down('KeyW');
    await frameUntil(page, frame, () => window.deusExViewer.status().gameplay.player.position[0] > -700, 240);
    await frameUntil(page, frame, () => {
      const p = window.deusExViewer.status().gameplay.player;
      return p.position[0] > -262 && Math.hypot(p.velocity[0], p.velocity[1]) < 5;
    }, 240);
    await page.keyboard.up('KeyW');
    await frame(10);
    await page.keyboard.press('KeyF');
    await frame(60);
    await page.keyboard.down('KeyW');
    await frame(75);
    await page.keyboard.up('KeyW');
    await frame(15);
  },
  // Crowbar preview: two swings break the crate into fragments and contents.
  async crowbar(page, frame) {
    await setSelect(page, 'preview', 'weapon');
    await frame(45);
    for (let swing = 0; swing < 2; swing++) {
      await page.keyboard.down('Enter');
      await frame(4);
      await page.keyboard.up('Enter');
      await frame(swing ? 110 : 34);
    }
  },
  // Munitions instructor: original ConPlay conversation with subtitles.
  async instructor(page, frame) {
    await setSelect(page, 'preview', 'instructor');
    await frame(100);
    await page.keyboard.press('KeyF');
    await frame(200);
  },
  async keypad(page, frame) {
    await setSelect(page, 'preview', 'keypad');
    await frame(20);
    await page.keyboard.press('KeyF');
    await frame(30);
    for (const key of ['Digit0', 'Digit0', 'Digit1', 'Digit2']) { await page.keyboard.press(key); await frame(12); }
    await frame(45);
  },
  async datacube(page, frame) {
    await setSelect(page, 'preview', 'datacube');
    await frame(15);
    await page.keyboard.press('KeyF');
    await frame(90);
  },
  async menu(page, frame) {
    await frame(10);
    await page.keyboard.press('Escape');
    await frame(60);
  },
  async light(page, frame) {
    await setSelect(page, 'preview', 'light');
    await frame(30);
    await setSelect(page, 'preview', 'light');
    await frame(30);
    await setSelect(page, 'preview', 'light');
    await frame(30);
  },
  // Inspect-camera orbit of the observation window (Jaime, the MIB, Walton Simons).
  async observers(page, frame) {
    const center = [360, 1210, -20];
    for (let i = 0; i < 120; i++) {
      const a = (-120 + i * 0.5) * Math.PI / 180, r = 190;
      const eye = [center[0] + Math.cos(a) * r, center[1] + Math.sin(a) * r, -10];
      await setCamera(page, eye, aimUnits(eye, center));
      await frame(1);
    }
  },
  // Inspect fly-through down the entrance hall, then the same path in wireframe.
  async flythrough(page, frame) {
    for (let i = 0; i < 150; i++) {
      const t = i / 149, e = t * t * (3 - 2 * t);
      const eye = [-1150 + e * 850, 830 + Math.sin(t * Math.PI) * 60, 40 - e * 60];
      await setCamera(page, eye, aimUnits(eye, [eye[0] + 400, 840 - Math.sin(t * Math.PI) * 40, -60]));
      await frame(1);
    }
  },
  async wireframe(page, frame) {
    await page.evaluate(() => {
      const box = document.getElementById('wireframe');
      box.checked = true;
      box.dispatchEvent(new Event('change', {bubbles: true}));
    });
    for (let i = 0; i < 120; i++) {
      const t = i / 119, a = (200 - t * 60) * Math.PI / 180;
      const eye = [-700 + Math.cos(a) * 500, 840 + Math.sin(a) * 500, 260 - t * 80];
      await setCamera(page, eye, aimUnits(eye, [-500, 840, -80]));
      await frame(1);
    }
  },
};

function aimUnits(eye, target) {
  const dx = target[0] - eye[0], dy = target[1] - eye[1], dz = target[2] - eye[2];
  const u = r => Math.round(((r / (2 * Math.PI)) * 65536 % 65536 + 65536) % 65536);
  return [u(Math.atan2(dz, Math.hypot(dx, dy))), u(Math.atan2(dy, dx)), 0];
}

async function frameUntil(page, frame, predicate, maxFrames) {
  for (let i = 0; i < maxFrames; i++) {
    if (await page.evaluate(predicate)) return;
    await frame(1);
  }
  console.log('  (frameUntil hit its limit)');
}

async function captureClips(names) {
  const selected = names.length ? names : Object.keys(clips);
  for (const name of selected) {
    const dir = path.join(out, 'clips', name);
    rmSync(dir, {recursive: true, force: true});
    mkdirSync(dir, {recursive: true});
    const {browser, page, errors} = await openViewer({width: 1920, height: 1080, args: GPU});
    try {
      await page.waitForFunction(() => window.deusExViewer.status().gameplay?.player?.grounded, null, {timeout: 120000});
      await enableClock(page);
      await step(page, 3);
      let index = 0;
      const frame = async (count = 1) => {
        for (let i = 0; i < count; i++) {
          await step(page, 1);
          await shot(page, path.join(dir, `f${String(index++).padStart(4, '0')}.jpg`), {type: 'jpeg', quality: 93});
        }
      };
      const t0 = Date.now();
      await clips[name](page, frame);
      const s = await status(page);
      console.log(name, `${index} frames`, `${((Date.now() - t0) / 1000).toFixed(0)}s`, s.runtimeError ? `RUNTIME ERROR: ${s.runtimeError}` : 'ok');
    } catch (error) {
      console.log(name, 'FAILED', error.message);
    } finally {
      if (errors.length) console.log('  page errors:', errors.slice(0, 3));
      await browser.close();
    }
  }
}

if (what === 'stills') await stills(rest[0]);
else if (what === 'clips') await captureClips(rest);
else console.log('usage: stills [map] | clips [names...]');
