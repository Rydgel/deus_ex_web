/**
 * Native EName values hardcoded by the original Deus Ex GOTY Core.dll.
 *
 * Evidence: .cache/research/Core.asm, Core initialization calls to
 * AllocateNameEntry at 0x1014d5dd through 0x1014de3b, with the pointed
 * UTF-16 strings in the original image's .data at 0x101acbc0..0x101ad0a8.
 * Core.dll SHA-256:
 * 8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4.
 * The source has one assigned entry at every index in [0x12c, 0x16c);
 * labels such as Probe4 are literal assigned names, not unassigned holes.
 * Keys are lower-cased for the VM's case-insensitive FName lookup.
 */
export const probeNames = new Map([
  ['spawned', 0x12c],
  ['destroyed', 0x12d],
  ['gainedchild', 0x12e],
  ['lostchild', 0x12f],
  ['probe4', 0x130],
  ['probe5', 0x131],
  ['trigger', 0x132],
  ['untrigger', 0x133],
  ['timer', 0x134],
  ['hitwall', 0x135],
  ['falling', 0x136],
  ['landed', 0x137],
  ['zonechange', 0x138],
  ['touch', 0x139],
  ['untouch', 0x13a],
  ['bump', 0x13b],
  ['beginstate', 0x13c],
  ['endstate', 0x13d],
  ['basechange', 0x13e],
  ['attach', 0x13f],
  ['detach', 0x140],
  ['actorentered', 0x141],
  ['actorleaving', 0x142],
  ['killcredit', 0x143],
  ['animend', 0x144],
  ['endedrotation', 0x145],
  ['interpolateend', 0x146],
  ['encroachingon', 0x147],
  ['encroachedby', 0x148],
  ['footzonechange', 0x149],
  ['headzonechange', 0x14a],
  ['paintimer', 0x14b],
  ['speechtimer', 0x14c],
  ['mayfall', 0x14d],
  ['probe34', 0x14e],
  ['die', 0x14f],
  ['tick', 0x150],
  ['playertick', 0x151],
  ['expired', 0x152],
  ['probe39', 0x153],
  ['seeplayer', 0x154],
  ['enemynotvisible', 0x155],
  ['hearnoise', 0x156],
  ['updateeyeheight', 0x157],
  ['seemonster', 0x158],
  ['seefriend', 0x159],
  ['specialhandling', 0x15a],
  ['botdesireability', 0x15b],
  ['probe48', 0x15c],
  ['probe49', 0x15d],
  ['probe50', 0x15e],
  ['probe51', 0x15f],
  ['probe52', 0x160],
  ['probe53', 0x161],
  ['probe54', 0x162],
  ['probe55', 0x163],
  ['probe56', 0x164],
  ['probe57', 0x165],
  ['probe58', 0x166],
  ['probe59', 0x167],
  ['probe60', 0x168],
  ['probe61', 0x169],
  ['probe62', 0x16a],
  ['all', 0x16b],
]);

/** The probe index (0x12c..0x16b) of a script function record, or 0xffffffff when its name is no probe name: UObject::ProcessInternal
 * (Core 0x1013f6c6-0x1013f6fe) runs a probe-named function only if its object's ProbeMask holds that bit, whoever calls it. */
export const probeIndex = record => probeNames.get(record.key.slice(record.key.lastIndexOf('.') + 1).toLowerCase()) ?? 0xffffffff;
