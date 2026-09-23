/** Read a globalconfig scalar from the installed Deus Ex .ini configuration.
 *
 * Unreal globalconfig properties (e.g. DeusExPlayer.bSubtitles) are stored in
 * the per-user configuration file — User.ini, seeded from DefUser.ini — under a
 * `[Package.Class]` section. This reads that value from the same `files` list
 * (each `{path, read}`) the AssetStore is built from, so a caller can honor the
 * installed preference without changing any compiled class default. It is a
 * targeted read of one shipped value, not a general config subsystem. */

function findConfigFile(files, leaf) {
  const target = leaf.toLowerCase();
  return files.find(file => String(file.path).replaceAll('\\', '/').split('/').pop().toLowerCase() === target) ?? null;
}

async function readText(file) {
  const data = await file.read();
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return new TextDecoder('latin1').decode(bytes);
}

/** Parse `[section] key=value` (case-insensitive) from ini text. Returns the
 * raw string value, or undefined when the section/key is absent. */
export function parseIniValue(text, section, key) {
  const wantSection = section.toLowerCase();
  const wantKey = key.toLowerCase();
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('[') && line.endsWith(']')) { current = line.slice(1, -1).toLowerCase(); continue; }
    if (current !== wantSection) continue;
    const equals = line.indexOf('=');
    if (equals < 0) continue;
    if (line.slice(0, equals).trim().toLowerCase() === wantKey) return line.slice(equals + 1).trim();
  }
  return undefined;
}

/** Read a boolean globalconfig value from User.ini (falling back to DefUser.ini
 * and then to `fallback`). Recognizes the original True/False spelling. */
export async function readGlobalConfigBool(files, section, key, fallback = false) {
  for (const leaf of ['User.ini', 'DefUser.ini']) {
    const file = findConfigFile(files, leaf);
    if (!file) continue;
    let value;
    try { value = parseIniValue(await readText(file), section, key); }
    catch { value = undefined; }
    if (value === undefined) continue;
    return /^(true|1)$/i.test(value);
  }
  return fallback;
}

/** Prepared scalar view shared by the input/HUD hosts. A missing property is
 * undefined, so callers can retain the original class default. Existing empty
 * values intentionally suppress the fallback, like the boolean reader above. */
export async function readUserConfig(files) {
  const sources=[];
  for(const leaf of ['User.ini','DefUser.ini']){
    const file=findConfigFile(files,leaf);
    if(file)sources.push({file:leaf,text:await readText(file)});
  }
  return {available:sources.length>0,files:sources.map(source=>source.file),
    get(section,key){
      for(const source of sources){
        const value=parseIniValue(source.text,section,key);
        if(value!==undefined)return value;
      }
      return undefined;
    },
  };
}

export async function readUserConfigValue(files,section,key,fallback=undefined) {
  return (await readUserConfig(files)).get(section,key)??fallback;
}
