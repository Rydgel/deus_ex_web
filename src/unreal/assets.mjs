import { parsePackage } from './package.mjs';
import { objectAt } from './objects.mjs';
import { layerConfigFiles } from '../runtime/config-store.mjs';
import { NameSpelling, BOOT_SCRIPT_PACKAGES } from './name-spelling.mjs';

/** Lazy package loading shared by browser File objects and local Node tools. */
export class AssetStore {
  /** `configStore` (config-store.mjs): the player's kept DeusEx.ini and User.ini, read over the installed ones and written back by
   * GConfig's Flush (docs/config-persistence.md). Without one the config files are the installed ones. */
  constructor(files, { configStore = null } = {}) {
    this.configStore = configStore;
    // The first spelling of a Name across packages (name-spelling.mjs): the boot script packages' names and the current map's, read by objects.mjs readObject.
    this.nameSpelling = new NameSpelling();
    this.bootNames = null;
    // Preserve the supplied filesystem catalog for native file-enumeration
    // services. Package lookup alone discards non-package files such as DMP.
    this.sourceFiles = [];
    this.files = new Map();
    this.packages = new Map();
    // Packages whose load has finished, for synchronous callers (loaded()).
    this.ready = new Map();
    this.configFiles = [];
    const iniFiles = [];
    // Installed native libraries by lowercase leaf name (System/*.dll), for
    // UPackage::BindPackage's appGetDllHandle. Only names are needed.
    this.libraries = new Set();
    for (const file of files) {
      this.sourceFiles.push(file);
      const leaf = file.path.replaceAll('\\', '/').split('/').pop();
      if (/\.ini$/i.test(leaf)) iniFiles.push(file);
      if (/\.dll$/i.test(leaf)) this.libraries.add(leaf.toLowerCase());
      if (!/\.(u|utx|dx|unr|uax|umx)$/i.test(leaf)) continue;
      const name = leaf.replace(/\.[^.]+$/, '');
      const key = name.toLowerCase();
      if (this.files.has(key)) throw new Error(`Ambiguous package name: ${name}`);
      this.files.set(key, { ...file, name });
    }
    // The config files as the original reads them: the first-run copy of a missing file, the player's kept file over the installed one.
    this.configFiles = layerConfigFiles(iniFiles, configStore);
  }

  /** The script packages the original's startup loads first, parsed (and their names entered) before any other package: a name they spell wins over a map's. */
  #boot() {
    this.bootNames ??= (async () => { for (const name of BOOT_SCRIPT_PACKAGES) if (this.files.has(name.toLowerCase())) await this.#load(name); })();
    return this.bootNames;
  }

  async get(name) {
    if (!BOOT_SCRIPT_PACKAGES.some(boot => boot.toLowerCase() === name.toLowerCase())) await this.#boot();
    return this.#load(name);
  }

  #load(name) {
    const key = name.toLowerCase();
    if (!this.packages.has(key)) {
      const file = this.files.get(key);
      if (!file) throw new Error(`Missing package: ${name}`);
      const pending = (async () => {
        const input = await file.read();
        const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
        const pkg = parsePackage(bytes);
        pkg.nameSpelling = this.nameSpelling;
        if (BOOT_SCRIPT_PACKAGES.some(boot => boot.toLowerCase() === key)) this.nameSpelling.addBoot(pkg);
        else if (/\.(dx|unr)$/i.test(file.path)) this.nameSpelling.beginLevel(pkg);   // a map parsed: the level it begins
        const exportsByPath = new Map(pkg.exports.map((e, i) => [e.path.toLowerCase(), i + 1]));
        return { name: file.name, path: file.path, bytes, pkg, exportsByPath };
      })();
      this.packages.set(key, pending);
      pending.then(value => this.ready.set(key, value), () => this.packages.delete(key));
    }
    return this.packages.get(key);
  }

  /** A package already loaded by get(), or undefined. */
  loaded(name) { return this.ready.get(name.toLowerCase()); }

  async resolve(asset, ref) {
    const entry = objectAt(asset.pkg, ref);
    if (!entry) throw new Error('Null object reference');
    if (ref > 0) return { asset, index: ref, entry, key: `${asset.name}.${entry.path}` };
    return importedObject(await this.get(entry.path.split('.')[0]), entry);
  }

  /** resolve() for a synchronous caller: null while the package an import
   * names is not loaded (loaded()). */
  resolveLoaded(asset, ref) {
    const entry = objectAt(asset.pkg, ref);
    if (!entry) throw new Error('Null object reference');
    if (ref > 0) return { asset, index: ref, entry, key: `${asset.name}.${entry.path}` };
    const target = this.loaded(entry.path.split('.')[0]);
    return target ? importedObject(target, entry) : null;
  }
}

/** An import's object in its loaded package `target`. */
function importedObject(target, entry) {
  const index = target.exportsByPath.get(entry.path.split('.').slice(1).join('.').toLowerCase());
  if (!index) throw new Error(`Missing object: ${entry.path}`);
  return { asset: target, index, entry: target.pkg.exports[index - 1], key: `${target.name}.${target.pkg.exports[index - 1].path}` };
}
