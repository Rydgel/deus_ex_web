/**
 * Object.Localize (docs/script-console-command.md "The typed console"): Core's UObject::execLocalize and the Localize it calls.
 *
 * execLocalize (Core 0x1013ce00): P_GET_STR SectionName, KeyName, PackageName (an empty FString passes L""), P_FINISH, then
 * Localize(Section, Key, Package, NULL, 0) and the result copied into the return FString.
 *
 * Localize (0x10148430), with GIsStarted and GConfig (both set in the game; without them it returns the key):
 *   LangExt = UObject::GetLanguage() (0x1015aae0: the static buffer 0x101ad748, built as "int", which SetLanguage 0x1015aaf0 fills)
 *   loop: GConfig->GetString(Section, Key, Result, 1024, appSprintf("%s.%s", Package, LangExt))  (vtable +0x10)
 *         found: Result.  Not found and LangExt is not "int" (appStricmp): LangExt = "int", again.
 *   neither, and not Optional: GLog->Logf(NAME_Warning 0x311, "No localization: %s.%s.%s (%s)", Package, Section, Key, LangExt) and
 *   Result = "<?%s?%s.%s.%s?>" (LangExt, Package, Section, Key).
 *
 * The file is the installed System/<Package>.<LangExt>, which GConfig reads as it reads the .ini files (config-cache.mjs). The shipped
 * DeusEx.ini and Default.ini both say Language=int; where the launcher calls SetLanguage is not traced, so another Language is refused.
 */
export const LOCALIZE = Object.freeze({execLocalize: 0x1013ce00, localize: 0x10148430, getLanguage: 0x1015aae0, setLanguage: 0x1015aaf0,
  languageBuffer: 0x101ad748, warningName: 0x311, size: 0x400});

/** GetLanguage's buffer as the installed configuration leaves it: "int", or a refusal for a Language the translation does not follow. */
export function configuredLanguage(config) {
  const language = config.getString('Engine.Engine', 'Language', null);
  if (language !== null && language.toLowerCase() !== 'int')
    throw new Error(`Localize under Language=${language} is not translated: the SetLanguage call that fills GetLanguage's buffer is not traced`);
  return 'int';
}

/** Localize(Section, Key, Package, NULL, 0) over `config` (a ConfigCache). `log(event)` receives the warning a missing key logs. */
export function localize(config, section, key, pkg, {log = null} = {}) {
  let language = configuredLanguage(config);
  for (;;) {
    const value = config.getString(section, key, `${pkg}.${language}`, LOCALIZE.size);
    if (value !== null) return value;
    if (language.toLowerCase() !== 'int') { language = 'int'; continue; }
    log?.(Object.freeze({text: `No localization: ${pkg}.${section}.${key} (${language})`, tag: 'Warning', tagIndex: LOCALIZE.warningName,
      source: 'Localize'}));
    return `<?${language}?${pkg}.${section}.${key}?>`;
  }
}
