/** Engine.dll AActor::ProcessRemoteFunction 0x103e5d90 (UObject vtable
 * +0x18; Core's UObject base 0x1013fa30 returns 0). Core ProcessEvent
 * (0x1013f862) calls it for a FUNC_Native function before running the native
 * body, and a nonzero result absorbs the call.
 *
 * A FUNC_Static function (0x2000) or a bDeleteMe actor returns 0. Absorb is
 * Role <= ROLE_SimulatedProxy (unsigned byte +0x31) without FUNC_Simulated
 * (0x100). A DemoRecDriver with a ServerConnection returns Absorb; at
 * NM_Standalone without a demo driver the result is 0, so the native runs
 * locally. The demo-recording call (ProcessDemoRecFunction) and the networked
 * NetModes are not translated (multiplayer is deferred) and throw.
 * Oracle: validate-native-client-hear-sound. */
export function actorProcessRemoteFunction(actor, functionFlags, {read}) {
  if (functionFlags & 0x2000) return 0;
  if (read(actor, 'bDeleteMe')) return 0;
  const absorb = (read(actor, 'Role') & 255) <= 2 && !(functionFlags & 0x100) ? 1 : 0;
  const driver = read(read(actor, 'XLevel'), 'DemoRecDriver');
  if (driver !== null) {
    if (read(driver, 'ServerConnection') !== null) return absorb;
    throw new Error('ProcessRemoteFunction demo recording (ProcessDemoRecFunction) is not translated');
  }
  if (read(read(actor, 'Level'), 'NetMode') === 0) return 0;
  throw new Error('ProcessRemoteFunction for a networked NetMode is not translated');
}
