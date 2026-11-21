// The trailer session's stretches, shared by trailer-capture.mjs and by scouting scripts: each takes the stage where the one before left it.
export const ISLAND = '01_NYC_UNATCOIsland';
export const top = async stage => (await stage.menu({op: 'state'})).top;
export async function expectTop(stage, want) { const got = await top(stage); if (got !== want) throw new Error(`the top window is ${got}, not ${want}`); }

/** The page's first click: it takes the pointer and lets the page start its sound; it reaches no binding (docs/boot.md). */
export async function firstClick(stage) {
  const {box} = stage.canvas;
  await stage.frames(2);
  await stage.page.mouse.move(box[0] + box[2] / 2, box[1] + box[3] / 2);
  await stage.click({hold: 2, after: 2});
}
/** From MenuMain: New Game, "train first?" No, Medium, the Start New Game screen's Start Game; then the intro, left with Escape, and the Island. */
export async function newGame(stage, {quick = false, onMenu, onScreen, onStart} = {}) {
  const glide = quick ? 8 : 40;
  await expectTop(stage, 'deusex.menumain');
  await stage.clickControl({field: 'winButtons', index: 0}, {glide, settle: quick ? 4 : 14, after: 20});     // New Game
  await onMenu?.();
  await expectTop(stage, 'deusex.menuuimessageboxwindow');         // "train first?" (bAskedToTrain is False on a fresh install)
  await stage.clickControl({field: 'btnNo'}, {glide: quick ? 8 : 20});
  await expectTop(stage, 'deusex.menuselectdifficulty');
  await stage.clickControl({field: 'winButtons', index: 1}, {glide: quick ? 8 : 20});      // Medium
  await expectTop(stage, 'deusex.menuscreennewgame');
  await onScreen?.();
  await stage.clickControl({actionKey: 'START'}, {glide, settle: quick ? 4 : 14, after: 2});
  await onStart?.();
  await stage.arrive('00_Intro');
  await stage.frames(90);
  await stage.key('Escape', {after: 2});                           // ShowMainMenu on mission 98: PostIntro, StartNewGame
  await stage.arrive(ISLAND);
}
/** Where the conversation stands: null, or {con, state, cls, speaker, text}. */
export async function talk(stage) {
  const c = (await stage.conversation())?.conPlay;
  return c ? {con: c.con, state: c.state, cls: c.event?.cls ?? null, speaker: c.event?.speaker ?? null, text: c.event?.text ?? null, label: c.event?.label ?? null} : null;
}
