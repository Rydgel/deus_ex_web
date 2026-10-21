/** Validation only (docs/script-native-config.md): one step of the original options menus on
 * whichever side runs the simulation (sim-worker `call settingsProbe`, or the page with ?sim=inline),
 * and the settings state it left. A step is `{op, ...}`:
 *   console {command}        PlayerPawn.ConsoleCommand through the viewport Exec chain
 *   menu {screens}           ShowMainMenu, then the button invoking each screen class in turn
 *   press {choice}           a choice's action button (cycle a value, open an action choice's screen)
 *   drag {choice, tick}      a slider choice's thumb to a tick
 *   action {action}          the screen's action button (1 OK, 2 Cancel, 3 Reset)
 *   cycleAll                 every value choice once
 *   button {index}           the top menu's winButtons[index] activated, as a click on it does (MenuMain: 4 is Training)
 *   center {field, index?, row?} | {actionKey}   where a click on a control of the top window lands (drawing-buffer pixels), returned as `result`
 *   controls                 every window under the top window (class, ancestry, absolute bounds, visible/sensitive bits), returned as `result`
 *   list {field, columns?}   the rows of a list window field of the top window (text of each column), their ids and the selection, as `result`
 *   text {field}             the text of a label or text window field of the top window, as `result`
 *   escape                   the Escape key on the root window
 *   field {name}             a field of the top window, or a dotted path through window fields (a window as its class)
 *   state                    nothing
 * The caller waits for frames between steps: the windows need their ticks. */
import { createMenuDriver } from './menu-driver.mjs';

export function settingsProbe(game, step = {op: 'state'}) {
  const driver = createMenuDriver(game), host = game.doors.scriptRuntime.windowHost, runtime = driver.runtime;
  let result = null;
  switch (step.op) {
    case 'console': result = host.consoleCommands.consoleCommand(driver.player, step.command); break;
    case 'menu': driver.showMainMenu(); break;
    case 'invoke': driver.invoke(step.screen); break;
    case 'button': driver.pressButton(step.index); break;
    case 'center': result = driver.center(step); break;
    case 'controls': result = driver.controls(); break;
    case 'list': result = driver.listRows(step.field, step.columns); break;
    case 'text': result = driver.windowText(step.field); break;
    case 'press': driver.press(step.choice); break;
    case 'drag': driver.drag(step.choice, step.tick); break;
    case 'action': driver.pressAction(step.action); break;
    case 'cycleAll': result = driver.cycleAll(); break;
    case 'escape': game.windowKey('Escape', true); game.windowKey('Escape', false); break;
    case 'field': {
      const value = step.name.split('.').reduce((object, name) => object && runtime.readNamed(object, name), driver.topWindow());
      result = value && typeof value === 'object' ? (runtime.instance(value)?.cls?.record?.key ?? 'object') : value;
      break;
    }
    case 'state': break;
    default: throw new Error(`Unknown settings probe step ${step.op}`);
  }
  const live = runtime.audio?.volumes?.state ?? null;
  return {
    result, top: driver.top(),
    display: {...host.display},
    audio: live ? {...live} : null,
    player: {mouseSensitivity: runtime.readNamed(driver.player, 'MouseSensitivity'), invertMouse: runtime.readNamed(driver.player, 'bInvertMouse')},
    client: {brightness: host.nativeConfig.instance('WinDrv.WindowsClient', 'Brightness')},
  };
}
