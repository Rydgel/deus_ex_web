/** Original Core linker import flow. Evidence: docs/script-linker-imports.md.
 *
 * Linkers carry parsed, process-wide-FName import/export records and canonical
 * root identities. Only external package/name/object services are supplied;
 * import matching, lazy construction and native counter/order belong here.
 * Diagnostic formatting, forgiving loads and exception unwind are explicit
 * unsupported boundaries, never successful null-import substitutes.
 */
export const LINKER_IMPORT_CONTRACT = Object.freeze({
  indexToObject: 0x1012e550, createImport: 0x1012e6c0,
  verify: 0x10160d80, verifyImport: 0x10160fd0,
  exportHashStart: 0x10160786, exportHashEnd: 0x1016086b,
  importStride: 0x1c, exportStride: 0x24, importCounter: 0x102a2658,
  names: Object.freeze({core: 0x14, unrealI: 0x17, unrealShare: 0x18, package: 0x298, class: 0x29b}),
});

export class LinkerImportBoundaryError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'LinkerImportBoundaryError';
    this.code = `LINKER_IMPORT_${kind}`;
  }
}
const fail = (kind, message) => { throw new LinkerImportBoundaryError(kind, message); };
function call(services, name, ...args) {
  if (typeof services[name] !== 'function') fail('SERVICE', `Linker import requires ${name}`);
  const result = services[name](...args);
  if (result?.then) fail('ASYNC', `Native linker ${name} cannot suspend`);
  return result;
}
const read = (object, field, services) => services.read ? call(services, 'read', object, field) : object?.[field];
function write(object, field, value, services) {
  if (services.write) call(services, 'write', object, field, value);
  else object[field] = value;
}
function isA(object, cls, services) {
  for (let c = read(object, 'class', services); c; c = read(c, 'superField', services)) {
    if (c === cls) return true;
  }
  return false;
}
function recordAt(records, index, kind) {
  if (!Number.isInteger(index) || index < 0 || index >= records.length) {
    fail('INDEX', `${kind} index ${index} requires the unsupported native bounds diagnostic`);
  }
  return records[index];
}
function incrementImports(services) {
  if (!Number.isInteger(services.state?.importCount)) fail('SERVICE', 'Linker import requires the Core import counter');
  services.state.importCount = (services.state.importCount + 1) | 0;
}

/** The class identity read by the original hash builder and VerifyImport. */
function exportClass(linker, record, services) {
  if (record.classIndex < 0) {
    const cls = recordAt(linker.imports, -1 - record.classIndex, 'class import');
    const pkg = recordAt(linker.imports, -1 - cls.packageIndex, 'class package import');
    return {name: cls.objectName, package: pkg.objectName};
  }
  if (record.classIndex > 0) {
    return {name: recordAt(linker.exports, record.classIndex - 1, 'class export').objectName,
      package: read(linker.root, 'name', services)};
  }
  return {name: 0x29b, package: 0x14};
}
const hash = (name, cls, pkg) => (name + cls * 7 + (pkg === 0x18 ? 0x17 : pkg) * 31) & 255;

/** Original constructor fragment: ascending exports prepend to 256 buckets. */
export function buildLinkerExportHash(linker, services = {}) {
  linker.exportHash = new Int32Array(256).fill(-1);
  for (let index = 0; index < linker.exports.length; index += 1) {
    const record = linker.exports[index];
    const cls = exportClass(linker, record, services);
    const bucket = hash(record.objectName, cls.name, cls.package);
    record.hashNext = linker.exportHash[bucket];
    linker.exportHash[bucket] = index;
  }
  return linker.exportHash;
}

export function linkerIndexToObject(linker, reference, services = {}) {
  if (!Number.isInteger(reference) || reference < -0x80000000 || reference > 0x7fffffff) {
    fail('INDEX', 'IndexToObject requires an int32 package reference');
  }
  if (reference === 0) return null;
  if (reference > 0) {
    recordAt(linker.exports, reference - 1, 'export');
    return call(services, 'createExport', linker, reference - 1);
  }
  return createLinkerImport(linker, -1 - reference, services);
}

export function createLinkerImport(linker, index, services = {}) {
  const record = recordAt(linker.imports, index, 'import');
  if (record.object != null) return record.object;
  if (record.sourceIndex >= 0) {
    if (!record.sourceLinker) fail('ASSERT', 'CreateImport: Import.SourceLinker (UnLinker.h:845)');
    record.object = call(services, 'createExport', record.sourceLinker, record.sourceIndex);
    incrementImports(services);
  }
  return record.object;
}

export function verifyLinkerImports(linker, services = {}) {
  if (!linker.verified) {
    if (linker.root && isA(linker.root, services.packageClass, services)) {
      write(linker.root, 'packageFlags', (read(linker.root, 'packageFlags', services) | 0) & ~8, services);
    }
    // +0x48 is the serialized summary count, not a growing ImportMap.Num.
    const count = linker.summaryImportCount ?? linker.imports.length;
    for (let index = 0; index < count; index += 1) verifyLinkerImport(linker, index, services);
  }
  linker.verified = 1;
}

export function verifyLinkerImport(linker, index, services = {}) {
  const record = recordAt(linker.imports, index, 'import');
  if (record.sourceIndex !== -1 || record.classPackage === 0 || record.className === 0 || record.objectName === 0) return;
  let packageRoot = null;
  let depth = 0;
  if (record.packageIndex === 0) {
    if (record.className !== 0x298 || record.classPackage !== 0x14) {
      fail('ASSERT', 'VerifyImport root must be Core.Package (UnLinker.h:530–531)');
    }
    const root = call(services, 'createPackage', null, call(services, 'nameText', record.objectName));
    // The UnrealI -> UnrealShare exception retry is deliberately not hidden
    // in this service call. File selection and its failures remain external.
    record.sourceLinker = call(services, 'getPackageLinker', root, null, 8, null, null);
  } else {
    if (record.packageIndex >= 0) fail('ASSERT', 'VerifyImport: Import.PackageIndex<0 (UnLinker.h:550)');
    verifyLinkerImport(linker, -1 - record.packageIndex, services);
    record.sourceLinker = recordAt(linker.imports, -1 - record.packageIndex, 'outer import').sourceLinker;
    if (!record.sourceLinker) fail('ASSERT', 'VerifyImport: Import.SourceLinker (UnLinker.h:553)');
    let outer = record;
    while (outer.packageIndex < 0) {
      outer = recordAt(linker.imports, -1 - outer.packageIndex, 'outer import');
      depth += 1;
    }
    packageRoot = call(services, 'createPackage', null, call(services, 'nameText', outer.objectName));
  }
  const source = record.sourceLinker;
  if (!source?.exportHash) fail('SERVICE', 'VerifyImport requires the owning linker export hash');
  for (;;) {
    let candidateIndex = source.exportHash[hash(record.objectName, record.className, record.classPackage)];
    while (candidateIndex !== -1) {
      const candidate = recordAt(source.exports, candidateIndex, 'source export');
      const cls = exportClass(source, candidate, services);
      const alias = record.classPackage === 0x17 && cls.package === 0x18;
      let matches = candidate.objectName === record.objectName && cls.name === record.className &&
        (cls.package === record.classPackage || alias);
      if (matches && record.packageIndex < 0) {
        const outer = recordAt(linker.imports, -1 - record.packageIndex, 'outer import');
        if (outer.sourceLinker) {
          matches = outer.sourceIndex === -1 ? candidate.packageIndex === 0
            : candidate.packageIndex === outer.sourceIndex + 1 || candidate.packageIndex === 0;
        }
      }
      if (matches) {
        if (!(candidate.objectFlags & 4)) {
          if (linker.loadFlags & 0x1000) fail('FORGIVING', 'Private import forgiving-load diagnostics are unsupported');
          fail('PRIVATE', `Private import ${call(services, 'nameText', record.objectName)} requires native error formatting`);
        }
        record.sourceIndex = candidateIndex;
        break;
      }
      candidateIndex = candidate.hashNext;
    }
    if (call(services, 'nameText', record.className).toLowerCase() !== 'mesh') break;
    record.className = call(services, 'nameIndex', 'LodMesh', 1);
  }
  if (record.sourceIndex !== -1 || !packageRoot) return;

  const classPackage = call(services, 'staticFindObject', services.packageClass, null,
    call(services, 'nameText', record.classPackage), 0);
  let allowMissing = false;
  if (classPackage) {
    const cls = call(services, 'staticFindObject', services.classClass, classPackage,
      call(services, 'nameText', record.className), 0);
    if (cls) {
      const object = call(services, 'staticFindObject', cls, packageRoot,
        call(services, 'nameText', record.objectName), 0);
      if (object && ((read(object, 'flags', services) | 0) & 0x04004004) === 0x04004004) {
        record.object = object;
        incrementImports(services);
      } else if ((read(cls, 'classFlags', services) | 0) & 0x40) {
        if (services.isEditor) fail('EDITOR', 'Missing transient import editor logging is unsupported');
        allowMissing = true;
      }
    }
  }
  if (record.object != null) return;
  if (read(packageRoot, 'name', services) === 0x17 && depth === 1) {
    fail('LEGACY', 'UnrealI missing import requires the synthetic UnrealShare import retry');
  }
  if (allowMissing) return;
  if (linker.loadFlags & 0x1000) fail('FORGIVING', 'Missing import forgiving-load diagnostics are unsupported');
  fail('MISSING', `Missing import ${call(services, 'nameText', record.objectName)} requires native error formatting`);
}
