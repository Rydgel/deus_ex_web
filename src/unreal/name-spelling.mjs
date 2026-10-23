/** The spelling of a Name value across packages (docs/stage-6-chains.md "Name spellings").
 *
 * An FName is one entry of GNames whatever the case a package spells it in: the first package that enters the name fixes the text every later reader sees (the name
 * table of a linker is entered in order when the package loads, and a later package's `DL_bodyexit` finds the existing `dl_bodyexit`). The original's load order is the
 * startup's packages (the script packages of docs/original-startup-log.md first), then the map, then the packages the map's start loads (the conversation lists, the
 * audio): measured on mission 0's chain, where the Training map spells a DataLinkTrigger's tag `dl_bodyexit` and DeusExConText spells the conversation `DL_bodyexit`: the
 * flag `ConPlayBase.EndConversation` makes with `StringToName(con.conName $ "_Played")` is `dl_bodyexit_Played` in the original's flag store and its travel text.
 *
 * The model has two layers, both first-spelling-wins: the boot script packages' names (kept for the life of the store) and the names of the level's map (replaced when a
 * level begins: the previous map's names are unreferenced and collected with it). `spell(text)` answers the boot layer's spelling, else the level's, else the text itself:
 * an unverified approximation of the original's registry (a name that stays alive across a travel keeps its spelling in the original; here it is the new level's). It is
 * applied to Name-typed property values only (objects.mjs readObject), never to property or object names, which code looks up by their exact spelling. */
export class NameSpelling {
  constructor() { this.boot = new Map(); this.level = new Map(); }

  /** A boot package's name table, first spelling wins. */
  addBoot(pkg) { for (const entry of pkg.names) { const key = entry.name.toLowerCase(); if (!this.boot.has(key)) this.boot.set(key, entry.name); } }

  /** A level begins: its map's name table replaces the previous level's. */
  beginLevel(pkg) {
    this.level = new Map();
    for (const entry of pkg.names) { const key = entry.name.toLowerCase(); if (!this.level.has(key)) this.level.set(key, entry.name); }
  }

  spell(text) {
    if (typeof text !== 'string') return text;
    const key = text.toLowerCase();
    return this.boot.get(key) ?? this.level.get(key) ?? text;
  }
}

/** The script packages the original's startup loads first (docs/original-startup-log.md: DeusEx Core Engine Extension ... ConSys). */
export const BOOT_SCRIPT_PACKAGES = Object.freeze(['DeusEx', 'Core', 'Engine', 'Extension', 'ConSys']);
