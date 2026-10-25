/** The spelling of a Name value across packages and levels: the process's FName table as far as spelling goes (docs/script-names.md "Spelling across levels").
 *
 * An FName is one GNames entry whatever the case a package spells it in. `FName(text, FNAME_Add)` (Core 0x1014b950) compares with `appStricmp` and returns an existing
 * entry unchanged, so the first spelling entered fixes the text every later reader sees; only the garbage collector's name pass deletes an entry (FName::DeleteEntry's one
 * caller, Core 0x1015844c). The original's process enters and collects names in this order:
 *
 * 1. The startup's packages (docs/original-startup-log.md): their linkers stay loaded for the whole process (their native classes are roots and mark them), so their
 *    names are never collected (`addBoot`).
 * 2. A level's LoadMap creates the new map's linker before anything of the previous level is collected: the `ULinkerLoad` constructor (Core 0x10160000, loop
 *    0x101604f9..0x101605db) enters each name of the file whose flags meet the load context (`+0xa0`: 0x30000 in the game) with FNAME_Add, while GNames still holds
 *    every name the previous level entered: its map, DeusExConText, the names its scripts made. The measured order (the original's mission 10 chain log): `Loading:
 *    Package 10_Paris_Chateau`, `Collecting garbage`, `Unloading: Package DeusExConText`, `Garbage: ...`, `Loading: Package DeusExConText`, `Login: Player`.
 * 3. LoadMap's collection (`CollectGarbage(RF_Native)`): a name survives when something reachable serializes it. The new map's linker is reachable (`UObject::Serialize`
 *    marks an object's `_Linker`, Core 0x10150296..0x1015029e, and the level's objects came from it) and `ULinker::Serialize` (Core 0x1011df90) marks its whole name
 *    map, so every name of the new map survives with the spelling step 2 gave it. DeusExConText's linker is not reachable (it is unloaded there, measured), so the
 *    conversation names no surviving package holds are deleted, and so are the names the previous level's scripts made (`beginLevel`).
 * 4. The level's start loads DeusExConText again (ConBindEvents' StaticLoadObject): its names find the surviving entries (`enterPackage`).
 *
 * So on mission 0's chain (a new process: Training before any DeusExConText) the flag `StringToName(con.conName $ "_Played")` makes is `dl_bodyexit_Played` (the map
 * spells the DataLinkTrigger's tag `dl_bodyexit`), and on mission 10's (the Metro's DeusExConText still loaded when the Chateau's names enter) it is
 * `DL_EverettContact_Played`, although the Chateau spells `DL_everettcontact` and `DL_everettcontact_played`: both measured in the original's flag store.
 *
 * Not modeled (docs/script-names.md): names held across a collection by objects that survive it (the root set's objects), the packages a level loads besides the map and
 * DeusExConText (its texture and sound packages, the conversation audio), the startup's Entry and DX maps for a session that opens a level directly, and a Player start's
 * collection. Applied to Name-typed property values (objects.mjs readObject: a lookup), to StringToName and to a travel text's Name values (FNAME_Add: `intern`), never to
 * property or object names, which code looks up by their exact spelling. */

// The linker's load-context mask for the game: GIsClient and GIsServer are set, GIsEditor clear (docs/script-console-command.md), so RF_LoadForClient|RF_LoadForServer.
const LOAD_CONTEXT = 0x00030000;

// appStricmp is _wcsicmp in the C locale: ASCII a-z fold, nothing else (docs/script-names.md "Interning and index reuse").
const fold = text => text.replace(/[a-z]+/g, run => run.toUpperCase());
// appStrlen stops at the first NUL.
const terminated = text => { const at = text.indexOf('\0'); return at < 0 ? text : text.slice(0, at); };

export class NameSpelling {
  constructor() {
    this.entries = new Map();     // folded text -> the spelling of the live entry
    this.permanent = new Set();   // folded names a startup package holds
  }

  #enter(pkg, held) {
    for (const entry of pkg.names) {
      if (!((entry.flags >>> 0) & LOAD_CONTEXT)) continue;   // the constructor maps it to NAME_None and enters nothing
      const text = terminated(entry.name);
      if (!text) continue;
      const key = fold(text);
      if (!this.entries.has(key)) this.entries.set(key, text);
      held?.add(key);
    }
  }

  /** A startup package's linker: its names are entered and never collected. */
  addBoot(pkg) { this.#enter(pkg, this.permanent); }

  /** A linker created during the level (the level start's DeusExConText): its names are entered, first spelling wins, and live until the next LoadMap collection. */
  enterPackage(pkg) { this.#enter(pkg, null); }

  /** LoadMap: the map's names are entered while the previous level's are still in the table, then the collection keeps the startup packages' names and the map's. */
  beginLevel(pkg) {
    const held = new Set();
    this.#enter(pkg, held);
    for (const key of this.entries.keys()) if (!this.permanent.has(key) && !held.has(key)) this.entries.delete(key);
  }

  /** `FName(text, FNAME_Add)` of a runtime string (StringToName, ImportText): the live entry's spelling, or the text, which becomes the entry until the next collection. */
  intern(text) {
    if (typeof text !== 'string') return text;
    text = terminated(text);
    if (!text) return text;
    const key = fold(text), live = this.entries.get(key);
    if (live !== undefined) return live;
    this.entries.set(key, text);
    return text;
  }

  /** The live entry's spelling of a name a loaded package holds, else the text itself. */
  spell(text) {
    if (typeof text !== 'string') return text;
    return this.entries.get(fold(terminated(text))) ?? text;
  }
}

/** The script packages of the original's startup whose names Play enters (docs/original-startup-log.md: DeusEx Core Engine Extension ... ConSys). The startup loads 15
 * more (DeusExCharacters, DeusExUI, DeusExItems, Effects, Fire, DeusExSounds, DeusExDeco, UBrowser, UWindow, IpDrv, DeusExText, Ambient, MoverSFX, IpServer,
 * MPCharacters); none of them is first to enter a name that DeusExConText or a map spells differently (scripts/validate-name-spelling.mjs), so they change no spelling. */
export const BOOT_SCRIPT_PACKAGES = Object.freeze(['DeusEx', 'Core', 'Engine', 'Extension', 'ConSys']);
