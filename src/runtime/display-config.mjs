/**
 * What the client config says about the viewport at startup (docs/config-persistence.md "Resolution").
 *
 * UWindowsViewport::ResizeViewport (WinDrv.dll 0x1110e2f6-0x1110e35d), reached from every SetRes, stores the new size in the client
 * object, FullscreenViewportX/Y/ColorBits when the viewport is fullscreen and WindowedViewportX/Y/ColorBits when it is not, then calls
 * `Client->SaveConfig()`. The next start opens the viewport at the size of the mode it starts in: StartupFullscreen picks the
 * Fullscreen* or the Windowed* keys. A size chosen while windowed therefore does not take effect at the next fullscreen start, in
 * the original or here.
 */
import { parseIniValue } from '../unreal/user-config.mjs';
import { msvcrtWtoi } from './script-text-parser.mjs';

const SECTION = 'WinDrv.WindowsClient';
const bool = value => value !== undefined && /^(true|1)$/i.test(value);

/** The viewport size a config text starts the game at: `{fullscreen, width, height}`, or null where the text lacks the keys. */
export function startupViewport(text) {
  if (typeof text !== 'string') return null;
  const fullscreen = bool(parseIniValue(text, SECTION, 'StartupFullscreen'));
  const prefix = fullscreen ? 'Fullscreen' : 'Windowed';
  const x = parseIniValue(text, SECTION, `${prefix}ViewportX`), y = parseIniValue(text, SECTION, `${prefix}ViewportY`);
  if (x === undefined || y === undefined) return null;
  const width = msvcrtWtoi(x), height = msvcrtWtoi(y);
  return width > 0 && height > 0 ? { fullscreen, width, height } : null;
}

/**
 * The resolution the player chose: the kept config's startup size when it is not the installed config's. The default start draws a 4:3
 * picture at the window's own pixel density whatever the installed file's size is (docs/boot.md "The page"), so the installed size
 * means "no choice" and a different one is a SetRes the player made; it fixes the drawing buffer as that SetRes did.
 */
export function chosenResolution(installedText, keptText) {
  const kept = startupViewport(keptText);
  if (!kept) return null;
  const installed = startupViewport(installedText);
  if (installed && installed.width === kept.width && installed.height === kept.height) return null;
  return { width: kept.width, height: kept.height };
}
