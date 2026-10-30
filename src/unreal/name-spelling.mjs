import { NameTable } from './package-tables.mjs';

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
// appStrlen stops at the first NUL.
const terminated = text => { const at = text.indexOf('\0'); return at < 0 ? text : text.slice(0, at); };

// The table below compares and hashes through this fold instead of making the folded string of every entry (the keys of the Map
// it replaced: 77,000 strings on the Island).
const foldCode = code => code >= 97 && code <= 122 ? code - 32 : code;
const foldedHash = text => {
  let hash = 0x811c9dc5 | 0;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ foldCode(text.charCodeAt(index)), 16777619);
  return hash;
};
const foldedEqual = (a, b) => {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (foldCode(a.charCodeAt(index)) !== foldCode(b.charCodeAt(index))) return false;
  return true;
};

const PERMANENT = 1, HELD = 2;

/** The names of a package table, as (text, flags) calls: a NameTable's columns, or a fixture's `[{name, flags}]`. */
function eachName(names, visit) {
  if (names instanceof NameTable) {
    const { texts, flagWords } = names;
    for (let index = 0; index < texts.length; index += 1) visit(texts[index], flagWords[index]);
  } else for (const entry of names) visit(entry.name, entry.flags >>> 0);
}

export class NameSpelling {
  constructor() {
    // The live entries, in the order they were entered: the spelling, its folded hash and its marks (PERMANENT: a startup package holds the
    // name; HELD: the map being entered holds it). `slots` is an open-addressing table of entry positions + 1.
    this.spellings = [];
    this.hashes = new Int32Array(64);
    this.marks = new Uint8Array(64);
    this.slots = new Int32Array(128);
    this.mask = 127;
  }

  /** The entry position of the name `text` spells (ASCII-folded), or -1. */
  #find(text, hash) {
    const slots = this.slots, mask = this.mask;
    for (let slot = hash & mask; ; slot = (slot + 1) & mask) {
      const held = slots[slot];
      if (held === 0) return -1;
      const entry = held - 1;
      if (this.hashes[entry] === hash && foldedEqual(this.spellings[entry], text)) return entry;
    }
  }

  #add(text, hash) {
    const entry = this.spellings.length;
    if (entry === this.hashes.length) {
      const hashes = new Int32Array(entry * 2), marks = new Uint8Array(entry * 2);
      hashes.set(this.hashes); marks.set(this.marks);
      this.hashes = hashes; this.marks = marks;
    }
    if ((entry + 1) * 2 > this.slots.length) this.#rehash(this.slots.length * 2, entry);
    this.spellings.push(text);
    this.hashes[entry] = hash;
    this.marks[entry] = 0;
    this.#place(entry, hash);
    return entry;
  }

  #place(entry, hash) {
    const slots = this.slots, mask = this.mask;
    let slot = hash & mask;
    while (slots[slot] !== 0) slot = (slot + 1) & mask;
    slots[slot] = entry + 1;
  }

  #rehash(capacity, count) {
    this.slots = new Int32Array(capacity);
    this.mask = capacity - 1;
    for (let entry = 0; entry < count; entry += 1) this.#place(entry, this.hashes[entry]);
  }

  #enter(pkg, mark) {
    eachName(pkg.names, (name, flags) => {
      if (!(flags & LOAD_CONTEXT)) return;   // the constructor maps it to NAME_None and enters nothing
      const text = terminated(name);
      if (!text) return;
      const hash = foldedHash(text);
      let entry = this.#find(text, hash);
      if (entry < 0) entry = this.#add(text, hash);
      this.marks[entry] |= mark;
    });
  }

  /** A startup package's linker: its names are entered and never collected. */
  addBoot(pkg) { this.#enter(pkg, PERMANENT); }

  /** A linker created during the level (the level start's DeusExConText): its names are entered, first spelling wins, and live until the next LoadMap collection. */
  enterPackage(pkg) { this.#enter(pkg, 0); }

  /** LoadMap: the map's names are entered while the previous level's are still in the table, then the collection keeps the startup packages' names and the map's. */
  beginLevel(pkg) {
    for (let entry = 0; entry < this.spellings.length; entry += 1) this.marks[entry] &= ~HELD;
    this.#enter(pkg, HELD);
    const spellings = [];
    let kept = 0;
    for (let entry = 0; entry < this.spellings.length; entry += 1) {
      if (!this.marks[entry]) continue;
      spellings.push(this.spellings[entry]);
      this.hashes[kept] = this.hashes[entry];
      this.marks[kept] = this.marks[entry];
      kept += 1;
    }
    this.spellings = spellings;
    this.marks.fill(0, kept);
    let capacity = 128;
    while (capacity < kept * 4) capacity *= 2;
    this.#rehash(capacity, kept);
  }

  /** `FName(text, FNAME_Add)` of a runtime string (StringToName, ImportText): the live entry's spelling, or the text, which becomes the entry until the next collection. */
  intern(text) {
    if (typeof text !== 'string') return text;
    text = terminated(text);
    if (!text) return text;
    const hash = foldedHash(text), live = this.#find(text, hash);
    if (live >= 0) return this.spellings[live];
    this.#add(text, hash);
    return text;
  }

  /** The live entry's spelling of a name a loaded package holds, else the text itself. */
  spell(text) {
    if (typeof text !== 'string') return text;
    const key = terminated(text), entry = this.#find(key, foldedHash(key));
    return entry < 0 ? text : this.spellings[entry];
  }
}

/** The script packages of the original's startup whose names Play enters (docs/original-startup-log.md: DeusEx Core Engine Extension ... ConSys). The startup loads 15
 * more (DeusExCharacters, DeusExUI, DeusExItems, Effects, Fire, DeusExSounds, DeusExDeco, UBrowser, UWindow, IpDrv, DeusExText, Ambient, MoverSFX, IpServer,
 * MPCharacters); none of them is first to enter a name that DeusExConText or a map spells differently (scripts/validate-name-spelling.mjs), so they change no spelling. */
export const BOOT_SCRIPT_PACKAGES = Object.freeze(['DeusEx', 'Core', 'Engine', 'Extension', 'ConSys']);
