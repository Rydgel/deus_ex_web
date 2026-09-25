import { parsePackage } from './package.mjs';
import { objectAt } from './objects.mjs';

/** Lazy package loading shared by browser File objects and local Node tools. */
export class AssetStore {
  constructor(files) {
    // Preserve the supplied filesystem catalog for native file-enumeration
    // services. Package lookup alone discards non-package files such as DMP.
    this.sourceFiles = [];
    this.files = new Map();
    this.packages = new Map();
    this.configFiles = [];
    // Installed native libraries by lowercase leaf name (System/*.dll), for
    // UPackage::BindPackage's appGetDllHandle. Only names are needed.
    this.libraries = new Set();
    for (const file of files) {
      this.sourceFiles.push(file);
      const leaf = file.path.replaceAll('\\', '/').split('/').pop();
      if (/\.ini$/i.test(leaf)) this.configFiles.push(file);
      if (/\.dll$/i.test(leaf)) this.libraries.add(leaf.toLowerCase());
      if (!/\.(u|utx|dx|unr|uax|umx)$/i.test(leaf)) continue;
      const name = leaf.replace(/\.[^.]+$/, '');
      const key = name.toLowerCase();
      if (this.files.has(key)) throw new Error(`Ambiguous package name: ${name}`);
      this.files.set(key, { ...file, name });
    }
  }

  async get(name) {
    const key = name.toLowerCase();
    if (!this.packages.has(key)) {
      const file = this.files.get(key);
      if (!file) throw new Error(`Missing package: ${name}`);
      const pending = (async () => {
        const input = await file.read();
        const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
        const pkg = parsePackage(bytes);
        const exportsByPath = new Map(pkg.exports.map((e, i) => [e.path.toLowerCase(), i + 1]));
        return { name: file.name, path: file.path, bytes, pkg, exportsByPath };
      })();
      this.packages.set(key, pending);
      pending.catch(() => this.packages.delete(key));
    }
    return this.packages.get(key);
  }

  async resolve(asset, ref) {
    const entry = objectAt(asset.pkg, ref);
    if (!entry) throw new Error('Null object reference');
    if (ref > 0) return { asset, index: ref, entry, key: `${asset.name}.${entry.path}` };
    const [packageName, ...parts] = entry.path.split('.');
    const target = await this.get(packageName);
    const index = target.exportsByPath.get(parts.join('.').toLowerCase());
    if (!index) throw new Error(`Missing object: ${entry.path}`);
    return { asset: target, index, entry: target.pkg.exports[index - 1], key: `${target.name}.${target.pkg.exports[index - 1].path}` };
  }
}
