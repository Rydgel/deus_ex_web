/** Play's `Save\` directory as the GameDirectory natives read it (docs/save-directory.md), and the pure bodies of those natives.
 *
 * The original reads the real disk through GFileManager (FindFiles, FileSize) and GetDiskFreeSpace. Play has no disk: it reads a SAVE
 * DIRECTORY, an object with the five reads below, which the page backs with browser storage or a folder (docs/save-storage.md; the page sends the
 * simulation its listing, `replace`). The default is `createSaveDirectory()`: empty, which is what the original shows on a fresh install.
 *
 *   directories()        the names of the directories directly under `<SavePath>` (`Current`, `QuickSave`, `Save0001`, ...), in the
 *                        order FindFirstFile returns them. NTFS returns ascending name order, so the in-memory directory sorts
 *                        case-insensitively; the order is measured only for the two directories of the Wine capture (docs/save-directory.md).
 *   files(directory)     [{name, size}] of the files directly in `<SavePath>\<directory>` (FindFiles with Files=1; size is FileSize)
 *   info(directory)      the SaveInfo of that slot, `{properties, snapshot}`, or null when `<directory>\SaveInfo.dxs` is absent.
 *                        `properties` holds the DeusExSaveInfo properties the file serialized (Year, Month, Day, Hour, Minute, Second,
 *                        DirectoryIndex, Description, MissionLocation, MapName, saveCount, saveTime, bCheatsEnabled); `snapshot` is
 *                        null or `{texture, palette, image?}`: the names of the Texture and Palette exports the file holds for the Snapshot
 *                        property, and `image` the decoded picture `{width, height, format, data (P8), colors (RGBA palette)}` when the texture
 *                        is one the reader decodes (save-info.mjs parseSaveInfo): without it the Snapshot property stays None.
 *   freeSpaceBytes()     the bytes available to the saves (GetDiskFreeSpaceEx's lpFreeBytesAvailable), or null when the call fails.
 *                        A HOST INPUT: the original asks the volume of its working directory; the page supplies what the browser can say.
 *
 * Fidelity: the interface is Play's, not the original's; what it returns for the three reads the natives make is what the originals'
 * FindFiles/FileSize/StaticLoadObject returned in the Wine captures (docs/save-directory.md "Measured"). */

/** The two spellings of a slot's directory (GetSaveInfo 0x10017eb0, GetSaveDirectorySize 0x100179d0): -1 is QuickSave, any other index
 * `Save%04d` (a negative index other than -1 gives the C format's "Save-002"). */
export function saveSlotDirectory(index) {
  if (index === -1) return 'QuickSave';
  const n = index | 0;
  return `Save${n < 0 ? '-' + String(-n).padStart(3, '0') : String(n).padStart(4, '0')}`;
}

/** FindFirstFile's wildcard match (`*` any run, `?` one character), case-insensitive as the Windows file system is. */
export function wildcardMatch(pattern, name) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i').test(name);
}

/** FFileManager::FileSize's result added to the running total the way GetSaveDirectorySize (0x100179d0) does: each file's size is divided by
 * 1024 as a signed 32-bit value rounded toward zero (`cdq; and edx, 0x3ff; add eax, edx; sar eax, 10`) and the sum is an int. */
export function saveDirectoryKilobytes(files) {
  let total = 0;
  for (const file of files) {
    const size = file.size | 0;
    total = (total + ((size + ((size >> 31) & 0x3ff)) >> 10)) | 0;
  }
  return total;
}

/** GetSaveFreeSpace (0x10017770): GetDiskFreeSpaceEx's free bytes, divided by 1024 as a signed 64-bit value (__alldiv, 0x1001bc10) and
 * returned as an int (the low 32 bits). A failed call (the Ex function returns 0) leaves the result 0. */
export function saveFreeKilobytes(freeBytes) {
  if (freeBytes === null || freeBytes === undefined) return 0;
  return Number(BigInt.asIntN(32, BigInt(Math.trunc(freeBytes)) / 1024n));
}

/** GetNewSaveFileIndex (0x10017cc0): over every entry of the directory list, copy the name, find "Save" in it (appStrstr, case-sensitive),
 * put a NUL at the fifth character of the match (`mov word ptr [eax+8], 0`) and read the number that starts at the SIXTH (`add eax, 0xa`:
 * the characters after the NUL), keeping the largest; the result is that largest plus one. So `Save0001` reads "001": the first digit of the
 * four is skipped, which `Save1234` shows (234). A name without "Save" adds nothing. `atoi` is appAtoi (the C runtime's _wtoi). */
export function newSaveFileIndex(names, atoi) {
  let largest = 0;
  for (const name of names) {
    const at = name.indexOf('Save');
    if (at < 0) continue;
    const value = atoi(name.slice(at + 5));
    if (value >= largest) largest = value;
  }
  return largest + 1;
}

/** GenerateSaveFilename (0x10017d60): `appSprintf("%s%04d.%s", "Save", index, DefaultSaveExt)`. */
export function generateSaveFilename(index, extension = 'dxs') {
  const n = index | 0;
  return `Save${n < 0 ? '-' + String(-n).padStart(3, '0') : String(n).padStart(4, '0')}.${extension}`;
}

/** The free space the Save directory reports until the host says otherwise: 8 GiB. There is no original value to measure (the original asks the
 * volume of its working directory: 92 GB on the Linux host of docs/save-directory.md, whatever the machine has); a fixed figure keeps headless
 * runs repeatable, the page replaces it with what the browser says (src/viewer/save-directory-host.mjs). */
export const DEFAULT_FREE_BYTES = 8 * 1024 ** 3;

let hostDirectory = null;
/** The one Save directory of this JavaScript realm (the page, or the simulation worker): it outlives the per-map sessions, as the files outlive
 * the original's levels. A session that wants its own passes `saveDirectory` to createGame. */
export function hostSaveDirectory() { return hostDirectory ??= createSaveDirectory({freeSpaceBytes: DEFAULT_FREE_BYTES}); }

/** The in-memory Save directory. `saves` is [{directory, files: [{name, size, bytes?}], info: {properties, snapshot} | null}]; none by default.
 * `freeSpaceBytes` is a number, a function, or null (the call fails). `Current` is a directory of the same shape: travel's `SaveCurrentLevel(-2)`
 * writes the levels it leaves there and `DeleteSaveGameFiles("")` empties it (docs/travel.md "The save directory"); the GameDirectory natives list
 * only the `Save*` directories, so it never shows in the Load Game screen.
 *
 * File I/O (the part a host backs with real storage: browser storage, a folder the user picks, docs/travel.md order step 4): `readFile`,
 * `writeFile`, `removeFile`, `clearDirectory`, `makeDirectory`, `copyFiles`. Names compare case-insensitively (the Windows file system the
 * original ran on: `FindFiles` and `FileSize` do not care how `MapName` spells a map), and keep the spelling they were written with. A file
 * written without bytes (a measured listing) has a size and no content. Every operation is synchronous, as the natives that call it are. */
export function createSaveDirectory({saves = [], freeSpaceBytes = null} = {}) {
  const slots = new Map();
  const key = name => String(name).toLowerCase();
  const slotOf = (name, create = false) => {
    let slot = slots.get(name);
    if (!slot && create) slots.set(name, slot = {files: new Map(), info: null});
    return slot ?? null;
  };
  const directory = {
    /** Add or replace a slot (a future SaveGame, a test). */
    put({directory: name, files = [], info = null}) {
      const slot = {files: new Map(), info};
      for (const file of files) slot.files.set(key(file.name), {name: file.name, size: file.bytes ? file.bytes.length : file.size, bytes: file.bytes ?? null, modified: file.modified ?? null});
      slots.set(name, slot);
      return directory;
    },
    /** Remove a slot (DeleteGame). */
    remove(name) { return slots.delete(name); },
    /** Replace every slot: the page's listing of its storage reaching the simulation (src/viewer/save-persistence.mjs; the simulation worker has no
     * storage of its own, the page sends the directory at startup and again whenever a folder, an import or a write changes it). */
    replace(list) {
      // `Current` is the simulation's own working directory (the levels it filed since the game started: travel.md "The save directory"); the page's storage
      // never lists it, so a listing that arrives mid-game (a write, a folder picked) leaves it as it is.
      const current = slots.get('Current');
      slots.clear();
      for (const save of list) directory.put(save);
      if (current && !slots.has('Current')) slots.set('Current', current);
      return directory;
    },
    directories: () => [...slots.keys()].sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0),
    files: name => [...(slotOf(name)?.files.values() ?? [])].map(file => ({name: file.name, size: file.size})),
    info: name => slotOf(name)?.info ?? null,
    freeSpaceBytes: () => typeof freeSpaceBytes === 'function' ? freeSpaceBytes() : freeSpaceBytes,
    setFreeSpaceBytes(value) { freeSpaceBytes = value; },
    /** GFileManager->MakeDirectory(dir, Tree=1): the directory exists (empty) afterwards. */
    makeDirectory(name) { slotOf(name, true); return directory; },
    /** The bytes of `<SavePath>\<dir>\<name>`, or null when there is no such file (or it was listed without content). */
    readFile(name, file) { return slotOf(name)?.files.get(key(file))?.bytes ?? null; },
    /** Whether `<SavePath>\<dir>\<name>` exists (GFileManager->FindFiles on its path finds one entry). */
    hasFile: (name, file) => Boolean(slotOf(name)?.files.has(key(file))),
    /** Write (create or replace) a file; the directory is made when absent. `bytes` is copied. */
    writeFile(name, file, bytes, {modified = Date.now()} = {}) {
      const copy = new Uint8Array(bytes);
      slotOf(name, true).files.set(key(file), {name: file, size: copy.length, bytes: copy, modified});
      return directory;
    },
    /** The modification time (ms) of one file, or null (a file listed without one): what CopySaveGameFiles keeps and what a slot's files report. */
    modifiedOf: (name, file) => slotOf(name)?.files.get(key(file))?.modified ?? null,
    /** Delete one file; true when it existed. */
    removeFile: (name, file) => slotOf(name)?.files.delete(key(file)) ?? false,
    /** DeleteSaveGameFiles(dir): every file goes, the directory stays; returns the names deleted. */
    clearDirectory(name) {
      const slot = slotOf(name);
      if (!slot) return [];
      const names = [...slot.files.values()].map(file => file.name);
      slot.files.clear();
      return names;
    },
    /** CopySaveGameFiles(src, dst): every `*.dxs` of src is copied into dst (made when absent). */
    copyFiles(source, target, pattern = '*.dxs') {
      const from = slotOf(source);
      if (!from) return [];
      const copied = [];
      for (const file of from.files.values()) {
        if (!wildcardMatch(pattern, file.name)) continue;
        slotOf(target, true).files.set(key(file.name), {name: file.name, size: file.size, bytes: file.bytes ? new Uint8Array(file.bytes) : null, modified: file.modified ?? null});
        copied.push(file.name);
      }
      return copied;
    },
  };
  for (const save of saves) directory.put(save);
  return directory;
}
