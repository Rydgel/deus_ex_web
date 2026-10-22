/** An in-memory File System Access directory tree for the tests of save-store.mjs: the handle methods it uses (`values`, `getDirectoryHandle`,
 * `getFileHandle`, `removeEntry`, `queryPermission`, `requestPermission`) with the errors a browser raises. */
const fail = (name, message = name) => { const error = new Error(message); error.name = name; return error; };

export function createFakeDirectory(name = 'Save', { permission = 'granted', clock = () => 1_700_000_000_000 } = {}) {
  const make = (dirName, state) => {
    const entries = new Map();
    const handle = {
      kind: 'directory', name: dirName, entries, state,
      async *values() { for (const entry of [...entries.values()]) yield entry; },
      async getDirectoryHandle(child, { create = false } = {}) {
        const found = entries.get(child);
        if (found) { if (found.kind !== 'directory') throw fail('TypeMismatchError'); return found; }
        if (!create) throw fail('NotFoundError', `A requested file or directory could not be found: ${child}`);
        const made = make(child, state); entries.set(child, made); return made;
      },
      async getFileHandle(child, { create = false } = {}) {
        const found = entries.get(child);
        if (found) { if (found.kind !== 'file') throw fail('TypeMismatchError'); return found; }
        if (!create) throw fail('NotFoundError', `A requested file or directory could not be found: ${child}`);
        const file = { kind: 'file', name: child, bytes: new Uint8Array(0), modified: clock(),
          async getFile() { return { size: file.bytes.length, lastModified: file.modified, async arrayBuffer() { return file.bytes.slice().buffer; } }; },
          async createWritable() {
            if (state.readOnly) throw fail('NoModificationAllowedError');
            let pending = null;
            return {
              async write(data) { if (state.failWrite) throw state.failWrite; pending = new Uint8Array(data); },
              async close() { file.bytes = pending ?? new Uint8Array(0); file.modified = clock(); },
              async abort() { pending = null; },
            };
          } };
        entries.set(child, file); return file;
      },
      async removeEntry(child, { recursive = false } = {}) {
        const found = entries.get(child);
        if (!found) throw fail('NotFoundError');
        if (found.kind === 'directory' && found.entries.size && !recursive) throw fail('InvalidModificationError');
        entries.delete(child);
      },
      async queryPermission() { return state.permission; },
      async requestPermission() { if (state.permission === 'prompt' && state.grantOnRequest) state.permission = 'granted'; return state.permission; },
    };
    return handle;
  };
  return make(name, { permission, grantOnRequest: true, readOnly: false, failWrite: null });
}

/** Put a file (bytes) at `dir/name` of a fake directory. */
export async function putFile(root, dir, name, bytes) {
  const handle = await (await root.getDirectoryHandle(dir, { create: true })).getFileHandle(name, { create: true });
  handle.bytes = new Uint8Array(bytes);
}
