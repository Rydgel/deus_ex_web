/** The script-side half of map travel (docs/travel.md "Native chain"): PlayerPawn.ClientTravel, UGameEngine::SetClientTravel with
 * the PreTravel events it sends, DeusExPlayer.DeleteSaveGameFiles (native 3012) and Play's `Save\Current` store.
 *
 * - `setClientTravel` is UGameEngine::SetClientTravel 0x1038fa10 (thunk 0x10303f2b): CastChecked<UViewport>(Player), the viewport's
 *   TravelURL (+0xa0), TravelType (+0x9c) and bTravelItems (+0xac), then ProcessEvent(PreTravel) on every actor of GLevel->Actors
 *   whose class has the function (Num re-read each pass). The level keeps running; UGameEngine::Tick's travel step (game.mjs
 *   clientTravel, travel.mjs) browses the URL after the tick.
 * - `PlayerPawn.ClientTravel` is APlayerPawn::execClientTravel 0x103df100: with a Player (+0x5d4) it fires PreClientTravel
 *   (Engine/PlayerPawn.uc:224, empty) and calls Engine->SetClientTravel(Player, URL, bItems, TravelType). An empty URL is passed as "".
 * - DeusExPlayer.DeleteSaveGameFiles (native 3012, DDeusExGameEngine::DeleteSaveGameFiles 0x10010360) releases the level package's
 *   loaders (the engine log's `Unloading: Package <level package>`), takes "" as `<SavePath>\\Current`, and deletes every file in it
 *   (the directory stays). Another directory is a save slot (docs/travel.md order step 4): an explicit stop.
 *
 * Play's `Save\Current` is an in-memory store of the files `SaveCurrentLevel(-2)` would write. Visited-map restoration is not
 * implemented (order step 3), so the store only ever empties here; it exists so DeleteSaveGameFiles has the directory to empty and
 * the tick's decisions have the files to look for. */
import { TravelBoundary } from './travel-boundary.mjs';
import { refValue } from './script-vm.mjs';

export class UnsupportedTravelNativeError extends Error {
  constructor(message, details = {}) { super(message); this.name = 'UnsupportedTravelNativeError'; Object.assign(this, details); }
}

/** UGameEngine::SetClientTravel for the viewport `viewport` (a UViewport script object). */
export function setClientTravel(runtime, viewport, url, items, type) {
  const actor = runtime.readNamed(viewport, 'Actor');
  if (!actor) throw new Error('SetClientTravel requires the viewport Actor');
  viewport.travelURL = url; viewport.travelType = type; viewport.bTravelItems = items;
  // GLevel: the viewport actor's level (Play's session holds one level)
  const actors = runtime.levelFor(actor).actors;
  for (let index = 0; index < actors.length; index++) {
    const target = actors[index];
    if (!target) continue;
    const record = runtime.lookup(target, 'PreTravel');
    if (record?.function) runtime.processEvent(target, 'PreTravel', [], null, record);
  }
}

/** Play's `<SavePath>\\Current`: file name -> bytes. DeleteSaveGameFiles releases the level package's loaders first
 * (`releaseLoaders`, once per level: the engine log's `Unloading: Package <level package>`), then deletes every file. */
export function createSaveStore({ releaseLoaders = () => {} } = {}) {
  const current = new Map();
  let released = false;
  return {
    current,
    /** DeleteSaveGameFiles(""): returns the names removed. */
    deleteCurrent() {
      if (!released) { released = true; releaseLoaders(); }
      const names = [...current.keys()];
      current.clear();
      return names;
    },
    has: name => current.has(name),
  };
}

/** Install ClientTravel and DeleteSaveGameFiles on a runtime. */
export function installTravelNatives({ runtime, store }) {
  const services = {
    store,
    clientTravel(receiver, url, type, items) {
      const viewport = runtime.readNamed(receiver, 'Player');
      if (!viewport) return;
      const record = runtime.lookup(receiver, 'PreClientTravel');
      if (record?.function) runtime.processEvent(receiver, 'PreClientTravel', [], null, record);
      setClientTravel(runtime, viewport, url, items, type);
    },
  };
  runtime.travelServices = services;
  const previous = runtime.native;
  runtime.boundaryNatives.add(3012);
  runtime.native = call => {
    if (call.index !== 3012) return previous(call);
    if (call.argumentCount > 1) throw new Error('DeleteSaveGameFiles accepts one optional directory');
    const directory = call.argumentCount === 1 ? String(refValue(call.evaluateArgument(0)) ?? '') : '';
    if (directory !== '')
      throw new UnsupportedTravelNativeError(`DeleteSaveGameFiles("${directory}"): deleting a save slot is not implemented (docs/travel.md order step 4)`, { native: 3012, directory });
    store.deleteCurrent();
    return undefined;
  };
  return services;
}

/** The ScriptRuntime's ClientTravel native: the recovered body where the session travels, else the named stop of travel-boundary.mjs. */
export function clientTravelNative(runtime, call, refValueOf) {
  if (call.argumentCount !== 3) throw new Error('ClientTravel requires URL, TravelType and bItems');
  const url = String(refValueOf(call.evaluateArgument(0))), travelType = refValueOf(call.evaluateArgument(1)) | 0, bItems = Boolean(refValueOf(call.evaluateArgument(2)));
  const services = runtime.travelServices;
  if (!services) throw new TravelBoundary({ url, travelType, bItems });
  return services.clientTravel(call.receiver, url, travelType, bItems);
}
