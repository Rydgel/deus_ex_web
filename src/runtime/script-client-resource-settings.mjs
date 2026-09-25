/** Client globals the native resource serializers read while loading.
 * Evidence and limits: docs/script-font-load.md ("Client loading inputs"). */

/**
 * GLazyLoad as the retail launcher sets it. DeusEx.exe 0x10908da6-0x10908e42:
 * GIsClient = !ParseParam(appCmdLine(), "SERVER"), then
 * GLazyLoad = !GIsClient || ParseParam(appCmdLine(), "LAZY"), then
 * GLazyLoad = 1 when GPhysicalMemory <= 0x4000000 (it logs "Low memory
 * conditions detected - Forcing lazy loading"). A client started without
 * -LAZY therefore loads eagerly (0). The physical-memory input is the host's
 * GlobalMemoryStatus value in the original; it must be supplied explicitly.
 */
export function clientLazyLoad({server = false, lazyParam = false, physicalMemory}) {
  if (!Number.isInteger(physicalMemory) || physicalMemory < 0)
    throw new TypeError('GLazyLoad derivation requires the GPhysicalMemory byte count');
  let lazy = (server || lazyParam) ? 1 : 0;
  if (physicalMemory <= 0x4000000) lazy = 1;
  return lazy;
}

/** A browser client: no -SERVER, no -LAZY, well above the 64 MB threshold. */
export const CLIENT_LAZY_LOAD = clientLazyLoad({physicalMemory: 0x7fffffff});

/**
 * UClient::StaticConstructor 0x10375010 registers enum `Details`
 * {High, Medium, Low, Ultra Low} and two CPF_Config (0x4000) UByteProperty
 * fields in category Display: TextureDetail at +0x78 (TextureLODSet[1],
 * LODSET_World) and SkinDetail at +0x7c (TextureLODSet[2], LODSET_Skin).
 * No property covers +0x74 (LODSET_None) or slots 3..7, so they keep the
 * zero class default. UBitmap::__Client (0x1058f044) is the client whose
 * TextureLODSet[LODSet] the texture mip helper uses as its bias.
 */
export const CLIENT_DETAILS = Object.freeze(['High', 'Medium', 'Low', 'Ultra Low']);

export function clientTextureLodSet(config, section = 'WinDrv.WindowsClient') {
  if (typeof config?.getString !== 'function') throw new TypeError('TextureLODSet requires GConfig');
  const lodSet = Array(8).fill(0);
  for (const [key, slot] of [['TextureDetail', 1], ['SkinDetail', 2]]) {
    const value = config.getString(section, key, null);
    if (value === null) continue; // LoadConfig leaves the zero default.
    const index = CLIENT_DETAILS.findIndex(name => name.toLowerCase() === value.toLowerCase());
    if (index < 0) throw new Error(`Unsupported ${section}.${key} config value: ${value}`);
    lodSet[slot] = index;
  }
  return lodSet;
}
