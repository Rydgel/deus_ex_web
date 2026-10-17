// The scenario of the interface acceptance (docs/interface-frames.md): the views both programs take, their inputs and their order. Shared by
// scripts/interface-acceptance.mjs (the capture and comparison) and the Stage 4 gate (scripts/validate-stage4-acceptance.mjs).
//
// A view is a list of steps, each of which a player has the means for:
//   ['cmd', line]        a console line (the original types it into its console through Talk; Play runs it through the original console command chain)
//   ['key', name]        a key press and release (names as dxinput's: ESC, F1, PRINT, ENTER, TAB; Play maps them to the page's key codes)
//   ['click', x, y]      a left click at the window's client coordinates (the original: dxinput `click`; Play: the page's mouse)
//   ['rclick', x, y]     a right click (ParseRightClick: the frob)
//   ['move', x, y]       the mouse moved there
//   ['pose', [x,y,z], [pitch,yaw,roll]]   the ghost placed and aimed: `set Location`, a zero Velocity, `set ViewRotation` (a ghost has no hash entry, so the
//                        write is the SET's; `walk` then re-adds the actor there). A walking player highlights FrobTarget in PlayerTick, a ghost does not.
//   ['wait', ms]         wall-clock time (the window system ticks on real time in both programs)
//   ['shot']             the frame is taken here, and named after the view
// A view with `modal: true` ends with a screen that takes every key but Print Screen (the root window's own `Shot`), so its shot is a Print; the others
// use the numpad * binding. The cursor is parked at (4, 4) before every shot so no button is under it.

export const WAIT_SCREEN = 1800, WAIT_CMD = 500;
const shotSteps = [['move', 4, 4], ['wait', 700], ['shot']];
const screen = (cmd, extra = []) => [...extra, ['cmd', cmd], ['wait', WAIT_SCREEN], ...shotSteps, ['key', 'ESC'], ['wait', WAIT_SCREEN]];
const settingsMenu = (...clicks) => [['key', 'ESC'], ['wait', WAIT_SCREEN], ['click', 640, 297], ['wait', WAIT_SCREEN], ...clicks.flatMap(([x, y]) => [['click', x, y], ['wait', WAIT_SCREEN]])];
const closeMenus = n => Array.from({length: n}, () => [['key', 'ESC'], ['wait', WAIT_SCREEN]]).flat();

/** The camera of each map's views: the map's start view (visual-acceptance.mjs `play` plans it: the start Location rounded to integers, the start yaw
 * snapped to a quarter turn), so the world under the interface is the one the frozen world frames compare. */
export const CAMERAS = {'00_Training': {location: [-1149, 826, -80], rotation: [0, 0, 0]}};

export const VIEWS = {
  // The HUD with a log line (`say` is a ClientMessage: the player's log and the HUD's msgLog).
  'ui-hud': {steps: [['cmd', 'say Interface frame'], ['wait', 600], ...shotSteps]},
  // The same, six seconds on: the log's timeout (logTimeout 3 s, HUDLogDisplay.Tick) has passed, so no log line is drawn on either side.
  'ui-hud-late': {steps: [['cmd', 'say Late frame'], ['wait', 6000], ...shotSteps]},
  'ui-inv': {modal: true, steps: screen('ShowInventoryWindow')},
  'ui-health': {modal: true, steps: screen('ShowHealthWindow')},
  'ui-skills': {modal: true, steps: screen('ShowSkillsWindow')},
  'ui-goals': {modal: true, steps: screen('ShowGoalsWindow', [['cmd', 'NoteAdd A note for the frame'], ['wait', WAIT_CMD]])},
  'ui-logs': {modal: true, steps: screen('ShowLogsWindow')},
  'ui-images': {modal: true, steps: screen('ShowImagesWindow')},
  'ui-conversations': {modal: true, steps: screen('ShowConversationsWindow')},
  'ui-augs': {modal: true, steps: screen('ShowAugmentationsWindow', [['cmd', 'AugAdd AugHealing'], ['wait', WAIT_CMD]])},
  // Esc opens the main menu (the binding). Its buttons are clicked where the window system placed them (the same coordinates on both sides). The click
  // on Settings is at y 297: the submenu that replaces the main menu has a 4-pixel gap between its Controls and Game Options buttons there, so no button
  // is under the cursor. At y 304 (the middle of Game Options) the original focused Game Options and Play kept the first button focused: a stationary
  // cursor over a screen that replaced another is a difference of the pointer input this scenario keeps out of the frame (docs/interface-frames.md).
  'ui-menu': {modal: true, steps: [['key', 'ESC'], ['wait', WAIT_SCREEN], ...shotSteps, ...closeMenus(1)]},
  'ui-settings': {modal: true, steps: [...settingsMenu(), ...shotSteps, ...closeMenus(2)]},
  'ui-options': {modal: true, steps: [...settingsMenu([640, 314]), ...shotSteps, ...closeMenus(3)]},
  'ui-colors': {modal: true, steps: [...settingsMenu([640, 386]), ...shotSteps, ...closeMenus(3)]},
  // WeaponCrowbar1 picked up by the right click (FrobTarget selected it at this pose in both programs): the belt's slot, the pickup's log line, then the
  // inventory screen with an item.
  'ui-belt': {steps: [['cmd', 'ghost'], ['pose', [1106, 330, -65], [56706, 16384, 0]], ['cmd', 'walk'], ['wait', WAIT_SCREEN], ['rclick', 640, 360], ['wait', 800], ...shotSteps]},
  'ui-inv2': {modal: true, steps: screen('ShowInventoryWindow')},
  // A frobbed screen: ghost, placed 48 units from DataCube0 and 56 in front of Keypad0 (the poses at which the original's FrobTarget was the object), `walk`, a
  // right click. The datacube's text shows in the HUD's information display until the next right click (the held level's Tick does not close it); the
  // keypad is a modal window.
  'ui-datacube': {steps: [['cmd', 'ghost'], ['pose', [1462, 826, -100], [54388, 8181, 0]], ['cmd', 'walk'], ['wait', WAIT_SCREEN], ['rclick', 640, 360], ['wait', 800],
    ...shotSteps, ['rclick', 640, 360], ['wait', WAIT_SCREEN]]},
  'ui-keypad': {modal: true, steps: [['cmd', 'ghost'], ['pose', [1942, 940, -108], [2457, 0, 0]], ['cmd', 'walk'], ['wait', WAIT_SCREEN], ['rclick', 640, 360], ['wait', WAIT_SCREEN],
    ...shotSteps, ['key', 'ESC'], ['wait', WAIT_SCREEN]]},
  // The world each view is drawn over, without the interface (`ShowHud False`), taken last in the same run: the camera of each view, reached by the
  // same steps (the ghost at the start view; ghost, pose and `walk` at a frob pose), after everything the scenario changed in the world (the crowbar is
  // in the belt). The comparison judges the share of identical pixels on the interface's own pixels: those where the two programs' world frames
  // already agree (the world is row 4.1.1's subject, judged there with its own metrics). Decided 2026-10-17 after the Mac capture, whose world
  // differs from Play by 1 level in 2.4% of the start view's pixels (docs/interface-frames.md "The Mac capture").
  'ui-base-start': {world: true, steps: [['cmd', 'ghost'], ['pose', CAMERAS['00_Training'].location, CAMERAS['00_Training'].rotation], ['cmd', 'ShowHud False'], ['wait', WAIT_SCREEN], ...shotSteps]},
  'ui-base-belt': {world: true, steps: [['cmd', 'ghost'], ['pose', [1106, 330, -65], [56706, 16384, 0]], ['cmd', 'walk'], ['wait', WAIT_SCREEN], ['cmd', 'ShowHud False'], ['wait', WAIT_SCREEN], ...shotSteps]},
  'ui-base-datacube': {world: true, steps: [['cmd', 'ghost'], ['pose', [1462, 826, -100], [54388, 8181, 0]], ['cmd', 'walk'], ['wait', WAIT_SCREEN], ['cmd', 'ShowHud False'], ['wait', WAIT_SCREEN], ...shotSteps]},
  'ui-base-keypad': {world: true, steps: [['cmd', 'ghost'], ['pose', [1942, 940, -108], [2457, 0, 0]], ['cmd', 'walk'], ['wait', WAIT_SCREEN], ['cmd', 'ShowHud False'], ['wait', WAIT_SCREEN], ...shotSteps]},
};

/** Each view's world frame (above): the frame of the same camera without the interface. */
export const BASES = {'ui-belt': 'ui-base-belt', 'ui-inv2': 'ui-base-belt', 'ui-datacube': 'ui-base-datacube', 'ui-keypad': 'ui-base-keypad'};
export const baseOf = view => VIEWS[view]?.world ? null : BASES[view] ?? 'ui-base-start';

/** The order is part of the scenario: the log's lines and the notes accumulate from view to view, the crowbar stays in the belt, and the frobbed screens
 * leave the player walking at their pose. One capture of the original and every Play run take the whole list in this order. */
export const ORDER = ['ui-hud', 'ui-hud-late', 'ui-inv', 'ui-health', 'ui-skills', 'ui-goals', 'ui-logs', 'ui-images', 'ui-conversations', 'ui-augs',
  'ui-menu', 'ui-settings', 'ui-options', 'ui-colors', 'ui-belt', 'ui-inv2', 'ui-datacube', 'ui-keypad', 'ui-base-start', 'ui-base-belt', 'ui-base-datacube', 'ui-base-keypad'];

/** The criteria of the Stage 4 gate (docs/stage-4-exit-criteria.md) and the views each judges. */
export const CRITERIA_VIEWS = {
  '4.4.11': ['ui-hud', 'ui-hud-late', 'ui-belt'],
  '4.4.12': ['ui-inv', 'ui-health', 'ui-skills', 'ui-goals', 'ui-logs', 'ui-images', 'ui-conversations', 'ui-augs', 'ui-inv2'],
  '4.4.13': ['ui-menu', 'ui-settings', 'ui-options', 'ui-colors'],
  '4.4.14': ['ui-datacube', 'ui-keypad'],
};
