/** DeusExPlayer.GetDeusExVersion (native 1099). Evidence: docs/script-font-load.md
 * ("Main menu version text"); checked by scripts/validate-deusex-version.mjs.
 *
 * ADeusExPlayer::GetDeusExVersion 0x10014270 calls
 * appSprintf(0x1003afcc, L"%s %s", appFromAnsi("Mon Mar 19 12:06:14 2001"),
 * *(TCHAR**)0x10034a18 = L"v1.112fm") and returns the static buffer. The exec
 * body 0x100147b0 steps the frame past EX_EndFunctionParms and assigns that
 * TCHAR buffer to the FString result (appStrlen + 1, Realloc(2), copy). */
export const DEUSEX_VERSION_NATIVE = Object.freeze({
  index: 1099, body: 0x10014270, exec: 0x100147b0, buffer: 0x1003afcc,
  format: 0x10034af4, timestamp: 0x10034b00, versionPointer: 0x10034a18, version: 0x10034a20,
  formatText: '%s %s', timestampText: 'Mon Mar 19 12:06:14 2001', versionText: 'v1.112fm',
});

export function getDeusExVersion() {
  const {timestampText, versionText} = DEUSEX_VERSION_NATIVE;
  return `${timestampText} ${versionText}`;
}
