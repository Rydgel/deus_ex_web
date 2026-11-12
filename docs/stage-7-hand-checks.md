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

## Results: Chrome 157, Linux, 2026-11-12

Google Chrome 157.0.8103.50 on the Linux host (Hyprland 0.56 on Wayland, one 1920×1080 screen at 240 Hz, a French AZERTY layout), the
production build of master 5483c6b3 served by `vite preview` on 127.0.0.1:5174, a fresh profile, the window tiled at 941×1030. The
assistant ran the checks in that real window: clicks through the DevTools protocol (trusted input, so the pointer lock and fullscreen
are granted as for a click), keys as real Wayland key events with their real key codes (Hyprland's `send_shortcut` and
`send_key_state`; `wtype` was dropped, as its own keymap gives every key the code of whatever it maps first, Escape), the sound read
from Chrome's own PipeWire stream (`parec --monitor-stream`, dBFS per window, the stream at 25 %). The user picked the game folder the
first time and clicked the one bubble Chrome gives no keyboard focus to ("Reconnect folder"'s). The two recorder reports, the
screenshots and the helper scripts are in `.work/hand-checks/2026-11-12-chrome-linux/` (local). No runtime error in either report.

| Row | Chrome 157, Linux |
| --- | --- |
| 7.5.1 | PASS. The logo map's song plays from the folder pick's click. Footsteps raise Training's level from about −72 to −56 dBFS. Hidden tabs of 22, 31 and 10 s keep the mix playing (the worklet's quanta advance through them, as the original's global-focus buffer would), and the sound is on after, 0 underruns; one 0.5 s window near silence came right after the 31 s hide and was not seen again at 0.2 s resolution. The default output switched HDMI → analog → HDMI in PipeWire (not a physical unplug) moves the stream with no gap and the context stays running. |
| 7.6.1 | PASS. The first click takes the pointer. One Escape: the browser releases the lock and the keydown still reaches the page 50 ms later; MenuMain opens once. W held, Ctrl+Tab away, W let go there, Ctrl+Tab back: the view did not move in the 2 s after (the held input let go), the level's clock went on. |
| 7.6.2 | PASS. Alt+Enter: fullscreen and the pointer, the picture 1440×1080 in 1920×1080. Escape held 2 s: the first press reaches the game (Keyboard Lock), Chrome leaves fullscreen and the pointer after 1.5 s. F11 outside fullscreen is the page's (`ActivateAugmentation 8`), so Chrome's own F11 fullscreen does not happen; the window made fullscreen by the window manager instead keeps 4:3 and the HUD. |
| 7.6.3 | PASS for zoom, another screen not run (one screen). Zooms of 80, 90, 110 and 125 % keep the picture 4:3 with its backing at the device pixels (941×705 for 1176.6×881.6 CSS px at 0.8, 940×705 for 752.2×564.2 at 1.25), the HUD and belt in place; the recorder logs each pixel-ratio change. Zooming in from the keyboard reaches Chrome only from its toolbar: the page takes Ctrl+= (Equals, `ShowScores`) and Ctrl+keypad plus (GreyPlus, `QuickSave`, which saved a game); Ctrl+keypad minus (unbound) zooms out. |
| 7.6.4 | PASS for a hidden tab, system sleep not run. Hidden 31.45 s: the level's clock advanced 2.57 s over 34 s of wall time, 2.55 s of them visible (no tick while hidden, no catch-up), back with no click, the sound on. |
| 7.8.1 | PASS. The gate's button opens the GTK portal's "Open File" dialog (its button "Upload"); Chrome then asks "Upload 299 files to this site? This will upload all files from "Deus Ex GOTY Edition". Only do this if you trust the site." with Cancel focused; with Upload the logo map loads. |
| 7.8.2 | PASS. Saved in Training: the slot is listed with its picture. Chrome shows no persistence prompt and `persist()` answers false (Chrome decides by engagement, without asking). After a reload Load Game lists the slot and loads it. |
| 7.8.3 | PASS for steps 1 and 2; step 3 (the original loading these slots) not run. "Use a Save folder…": the dialog "Select where this site can save changes", then Chrome's "Allow this site to edit files? http://127.0.0.1:5174 will be able to edit files in Save" (Don't Allow focused, Allow). Two saves write `Save0001` and `Save0002` (`00_training.dxs`, `SaveInfo.dxs`). The tab closed and opened: the page keeps the folder and offers "Reconnect folder"; Chrome's bubble "View and edit files from the last time you visited this site: Save" (Allow this time, Allow on every visit, Don't allow); allowed, the Saves window reads 2 saves and Load Game lists both slots and loads one. |

Firefox is not installed on the Linux host, so its run, the Mac, system sleep, a second screen, a physical output unplug and 7.8.3's
step 3 remain.
