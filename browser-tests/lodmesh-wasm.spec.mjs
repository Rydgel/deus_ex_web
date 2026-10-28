import {test,expect} from '@playwright/test';
import { BASE } from './browsers.mjs';

// Play's simulation loads WebAssembly kernels (the Rust core, docs/rust-core.md); the JavaScript pose fallback this spec once checked
// is gone. With every .wasm refused the map still loads for inspection, Play is no longer offered, and the debugging page's notes say
// so (sim-host.mjs: "Play mode unavailable: ..."). The default start says nothing yet: row 7.7.2 of docs/stage-7-exit-criteria.md.
test('refused WebAssembly leaves the map to inspect, takes Play away and says so in the notes',async({page})=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*.wasm',route=>route.abort());
  await page.goto(`${BASE}/?debug=1`);
  await page.waitForFunction(()=>window.deusExViewer?.status().ready);
  await page.locator('#scene').click({position:{x:500,y:350}});
  expect(await page.evaluate(()=>window.deusExViewer.status())).toMatchObject({mode:'inspect',map:'00_Training',runtimeError:null,npcPreview:null,gameplay:null});
  await expect(page.locator('#mode option').first()).toBeDisabled();
  await expect(page.locator('#notes')).toContainText('Play mode unavailable');
  expect(errors).toEqual([]);
});
