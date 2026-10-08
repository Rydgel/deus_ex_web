/** Drive the original menu windows through their own buttons and sliders, on
 * whichever side runs the simulation (validation and census only; sim-worker
 * `call settingsProbe`, scripts/census-ui-screens.mjs). Each action is what a
 * click or key would reach: XButtonWindow::ActivateButton on a menu button,
 * the choice's action button, or the slider's SetTickPosition (the thumb
 * drag), so the original MenuUI scripts run unchanged. The caller lets
 * frames pass between actions (the windows need their ticks). */
export function createMenuDriver(game) {
  const runtime = game.doors.scriptRuntime.runtime, host = game.doors.scriptRuntime.windowHost, W = host.W;
  const player = game.player.collisionActor;
  const keyOf = win => win ? runtime.instance(win).cls.record.key : null;
  const rootWindow = () => runtime.readNamed(player, 'rootWindow');
  /** The topmost modal window (root +0x140 lastChild, skipping non-modal children). */
  function topWindow() {
    const root = rootWindow();
    let window = root ? W.ptr(root, 0x140) : 0;
    while (window && W.u8(window, 0x28) < 2) window = W.ptr(window, 0x144);
    return window || null;
  }
  /** A descendant of `win` whose script class is `key` (firstChild +0x13c, nextSibling +0x148). */
  function findDescendant(win, key) {
    for (let child = W.ptr(win, 0x13c); child; child = W.ptr(child, 0x148)) {
      if (keyOf(child) === key) return child;
      const found = findDescendant(child, key);
      if (found) return found;
    }
    return null;
  }
  const choiceKey = name => `deusex.${name.toLowerCase()}`;
  const activate = button => game.hud.scoped(() => W.native.activateButton(button, 1));
  const inherits = (win, key) => { for (let cls = runtime.instance(win).cls; cls; cls = cls.base) if (cls.record.key === key) return true; return false; };
  return {
    runtime, W, player, topWindow, findDescendant, top: () => keyOf(topWindow()),
    /** ShowMainMenu (the Escape key's menu). */
    showMainMenu() { game.hud.scoped(() => runtime.scriptConsoleExec(player, 'ShowMainMenu')); },
    /** The button of the topmost menu window whose buttonDefaults invoke `screenClass`, activated. */
    invoke(screenClass) {
      const menu = topWindow(), defaults = runtime.readNamed(menu, 'buttonDefaults'), buttons = runtime.readNamed(menu, 'winButtons');
      const index = defaults.findIndex(entry => Object.entries(entry).find(([key]) => key.endsWith('.invoke'))?.[1]?.key === `deusex.${screenClass.toLowerCase()}`);
      if (index < 0) throw new Error(`${keyOf(menu)} has no button invoking ${screenClass}`);
      activate(buttons[index]);
    },
    /** The window of the choice class `name` on the open screen. */
    choice(name) {
      const choice = findDescendant(topWindow(), choiceKey(name));
      if (!choice) throw new Error(`${keyOf(topWindow())} has no choice ${name}`);
      return choice;
    },
    /** The choice's action button, activated (cycles a value choice, invokes an action choice). */
    press(name) { activate(runtime.readNamed(this.choice(name), 'btnAction') ?? runtime.readNamed(this.choice(name), 'btnInfo')); },
    /** A slider choice (MenuUIChoiceSlider): the thumb to `tick`, as a drag does. */
    drag(name, tick) {
      const choice = this.choice(name), slider = runtime.readNamed(runtime.readNamed(choice, 'btnSlider'), 'winSlider');
      game.hud.scoped(() => W.native.setTickPosition(slider, tick));
    },
    /** The value a choice currently shows (MenuUIChoice GetValue is a script function: read the slider). */
    sliderState(name) {
      const choice = this.choice(name), slider = runtime.readNamed(runtime.readNamed(choice, 'btnSlider'), 'winSlider');
      return {position: W.i32(slider, 0x1c8), ticks: W.i32(slider, 0x1c4)};
    },
    /** Every value choice (not a MenuUIChoiceAction) on the open screen, activated once; returns the class names. */
    cycleAll() {
      const cycled = [];
      const walk = win => {
        for (let child = W.ptr(win, 0x13c); child; child = W.ptr(child, 0x148)) {
          const key = keyOf(child);
          if (/^deusex\.menuchoice_/.test(key)) {
            if (!inherits(child, 'deusex.menuuichoiceaction')) {
              activate(runtime.readNamed(child, 'btnAction') ?? runtime.readNamed(child, 'btnInfo'));
              cycled.push(key.slice(7));
            }
          } else walk(child);
        }
      };
      walk(topWindow());
      return cycled;
    },
    /** The screen's action button with `action` (1 OK, 2 Cancel, 3 Reset to defaults), activated. */
    pressAction(action) {
      const screen = topWindow(), entry = runtime.readNamed(screen, 'actionButtons')
        .find(candidate => Object.entries(candidate).find(([key]) => key.endsWith('.action'))?.[1] === action);
      if (!entry) throw new Error(`${keyOf(screen)} has no action button ${action}`);
      activate(Object.entries(entry).find(([key]) => key.endsWith('.btn'))[1]);
    },
  };
}
