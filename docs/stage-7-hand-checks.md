# Stage 7 checks by hand

The rows of [Stage 7's exit criteria](stage-7-exit-criteria.md) whose last part a headless browser cannot produce: a real hidden tab,
system sleep, a held key the browser keeps for itself, a zoom or another screen, the system's folder picker and the persistence prompt.
Each is about 15 minutes in one browser. Do each in Chrome and in Firefox, on the Mac or the Linux desktop, and write what happened
under the row (browser, version, machine, date, pass or what differed). Safari is out of Stage 7 (2026-11-10).

**Setup.** The production build, as a player gets it:

```bash
npm run build
```

```bash
npx vite preview --host 127.0.0.1 --port 5174
```

Open `http://127.0.0.1:5174/?checks=1` (the original start: the folder gate, then the logo map), pick the game folder, and load
Training from MenuMain. Keep the sound on, low (several checks are about the audio). `?debug=1` is not needed and changes the page; leave
it off.

**The recorder (`?checks=1`, 2026-11-11).** A one-line panel in the bottom left corner ("Checks recorder", a count of events, Copy report,
Save, Clear) records what each row below looks for while you only act: the hidden intervals with the level's game time before and after
and the frames, music and movement around them; a stop of the whole page while visible (system sleep); the audio context's changes, an
output device change and underruns; Escape, F11, Alt+Enter and W as the page received them, with the pointer lock and fullscreen state;
the pixel ratio and canvas sizes; the folder picks, the saves' source and the persistence answer; and any error. It keeps its log across a
reload in the same tab. When a browser's checks are done, press **Copy report** (or Save, which downloads it) and paste the text back:
the per-row facts are at the top, the full event list below. It adds only that panel to the page (passive listeners and the page's read
probes, `src/viewer/hand-checks.mjs`). Use a new tab (or Clear) for the second browser's run.

## 7.5.1 Sound after a hidden tab or an interruption

1. Click into the logo map: its song starts.
2. Load Training, walk (footsteps), then switch to another tab for 20 s, and come back.
   Expected: no sound while hidden is acceptable, or the mix keeps playing (the original's buffer is global-focus); either way the music
   and the footsteps are back without a click when the tab is shown.
3. Interrupt the audio device: unplug or switch the output (headphones), or on the Mac let another app take exclusive audio, then
   return. Expected: the game's sound comes back by itself (the context resumes), no error toast.

## 7.6.1 Escape and the pointer

1. In Training, click once: the pointer is taken (no cursor), the view turns with the mouse.
2. Press Escape once. Expected: one press opens MenuMain (the browser releases the pointer and the game gets the key); a second press
   is not needed. Note if the browser shows its own "press Esc to exit" banner and whether it takes a press.
3. Close the menu, click to take the pointer again; switch tab or app (Cmd/Alt+Tab) while holding W, then come back. Expected: the
   player is not still walking (held input let go), Play went on.

## 7.6.2 Fullscreen, a held Escape and F11

1. Alt+Enter (Option+Enter on the Mac where the browser allows it): fullscreen, the pointer taken.
2. Hold Escape for two seconds. Expected as [input bindings](input-bindings.md) says: in Chrome (Keyboard Lock) a press reaches the game
   and a long hold leaves fullscreen; in Firefox the first press leaves the pointer and fullscreen. Note what happened.
3. F11 (Linux) or the browser's own fullscreen key (Ctrl+Cmd+F on the Mac): the picture stays 4:3, the HUD in place.

## 7.6.3 Zoom and another screen

1. In Training, zoom the page in and out (Ctrl/Cmd + and -, then 0). Expected: the picture stays 4:3 and sharp at the new pixel ratio,
   the HUD stays in place, no error. (A mirror: validate-resize-play.mjs uses one in Paris, 10_Paris_Catacombs, if you want one in view.)
2. If a second screen with another pixel ratio is at hand, drag the window to it and back. Expected: the same.

## 7.6.4 A hidden tab and system sleep

1. In Training, note the in-game clock (or stand by a timed thing, e.g. a door closing), hide the tab for 30 s, come back.
   Expected: no catch-up (the world did not jump 30 s ahead), it resumes by itself without a click, the audio follows.
2. Put the machine to sleep for a minute with the game running in a visible tab, wake it. Expected: the same, no error toast.

## 7.8.1 The folder picker

1. On a fresh profile (or after clearing the site's data), open the page: the gate asks for the game folder.
2. Pick the game folder in the system's picker (Chrome: a directory picker; Firefox: the folder upload dialog). Expected: the logo map
   loads. Note any permission prompt and its wording.

## 7.8.2 Browser storage and the persistence prompt

1. In Training, save a game (Esc, Save Game). Expected: the save is listed, and the browser may ask to store data persistently once;
   note the prompt and answer it "deny" in one browser and "allow" in the other.
2. Reload, Load Game: the save is there and loads, with either answer. A later save asks no second time.

## 7.8.3 A Save folder on disk (Chrome)

1. In Chrome, open the Saves window ("Saves…" on the gate or the page's bar, Alt+S) and press "Use a Save folder…"; pick a folder on
   disk (a copy of the desktop game's `Save` folder, or the game folder, whose `Save` child is then used).
2. Save twice in Training; close the tab; open the page again: the folder is kept (no new pick; at most "Reconnect folder", one click and
   the browser's own prompt), and Load Game lists the slots.
3. Load one of these slots in the desktop game (the original under Wine or CrossOver, its Save folder pointed at the copy). Expected:
   the original lists and loads it.

## Recording

Per browser: the recorder's report (Copy report), and in a line per row what you saw that it cannot (the sound coming back, the
picture sharp, the browser's own banner or prompt and its wording), PASS or what differed, and a screenshot where something looked
wrong. I turn them into row updates in `scripts/stage7-criteria.mjs`.
