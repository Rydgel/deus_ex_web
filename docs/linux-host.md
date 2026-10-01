# Linux host (Omarchy / Arch, x86-64)

How to run this project's reverse-engineering work on a second machine running
Linux. The Mac remains the reference machine for the 120 fps target (AGENTS.md),
so take performance measurements there. On Linux, the real-x87 probes run on
the CPU itself instead of under Rosetta.

## 1. Before copying (on Linux)

```bash
sudo pacman -S --needed openssh rsync
sudo systemctl enable --now sshd
```

Then, on the Mac, `ssh-copy-id user@host` so rsync can log in without a password.

## 2. Copy (on the Mac)

```bash
tools/copy-to-linux.sh user@host
```

The default destination is `~/deus_ex_web`. The script sends about 2 GB: the
repo with every local branch, the game install, `Reference/`, `.cache/`,
`reports/`, `.work/` without logs or worktrees, the CrossOver bottle's game
folder (into `~/.wine-deusex/drive_c`) and Claude Code's project memory. It
leaves out node_modules, the Python venv, Rust build output, worktrees,
perf traces and the ad capture output. It refuses to run a second time once a
copy has completed. To force another run, delete `.git/copied-from-mac` on
Linux. That run overwrites any Linux file that also exists on the Mac with
different contents, so commit or move Linux-side work first.

## 3. Toolchains (on Linux)

```bash
sudo pacman -S --needed git rustup wine mingw-w64-gcc python
mise use -g node@26
rustup default stable
rustup target add wasm32-unknown-unknown
```

If pacman reports `target not found: wine`, uncomment `[multilib]` in
`/etc/pacman.conf` and run `sudo pacman -Sy`. Without mise, use
`sudo pacman -S nodejs npm`. The Mac runs Node 26.8.2. Any Node ≥ 22.12 satisfies `package.json`, but
keeping the same major version avoids V8 differences.

## 4. Project setup (in `~/deus_ex_web`)

```bash
npm ci
npm run build:wasm
npx playwright install chromium
python -m venv .cache/native-probe-env
.cache/native-probe-env/bin/pip install capstone==5.0.9 unicorn==2.1.4
WINEPREFIX=~/.wine-deusex wineboot -u
```

If Chromium later fails with a missing shared library, install
`sudo pacman -S --needed nss atk at-spi2-core libcups libdrm libxkbcommon mesa alsa-lib pango cairo gtk3`.
Playwright's `--with-deps` does not support Arch.

Add to the shell profile:

```bash
export NATIVE_PROBE_PYTHON=$HOME/deus_ex_web/.cache/native-probe-env/bin/python
export WINEPREFIX=$HOME/.wine-deusex
export X87_PROBE_WINE=/usr/bin/wine
```

The validators also set `CX_BOTTLE`, which only CrossOver reads. Plain wine
uses `WINEPREFIX` instead. The game sits at `C:\Deus Ex GOTY Edition`, the same
path as in the bottle, so the `dump-*-win.exe` instructions are unchanged.

## 5. Check

```bash
npm test
node scripts/validate-x87-transcendental-hardware.mjs
npm run validate -- --jobs 4
```

## Known gaps

- **D3D control word.** Wine is still in between here, as it is with CrossOver.
  A `DDSCL_FPUSETUP` control word measured under wine shows wine's
  reimplementation (wined3d), not Microsoft's. Only a Windows install can
  settle that question.
- **x87 vendor.** The four hardware-x87 validators (transcendental, pawn
  perception, pawn locomotion, window scene frame) were last measured under
  Rosetta. On AMD silicon, fsin/fcos/fptan/fpatan may differ. A disagreement
  would be a finding to investigate, since the original game ran on both Intel
  and AMD CPUs. It does not mean the copy is broken.
- `scripts/validate-gpu-mesh.mjs` always launches Chromium with
  `--use-angle=metal`, which exists only on macOS. It needs a Linux branch
  before it can be trusted there.
- `ad/scripts/original-game.mjs` hard-codes the CrossOver bottle path under
  `~/Library`. The ad capture pipeline stays on the Mac.
- The `.work/tools` perf scripts hard-code `/Users/gcc` paths. Performance
  work stays on the Mac.
- The validator runner reads memory pressure on macOS only. On Linux only its
  per-validator RSS cap applies.
- Claude Code's `machine-memory-budget` note describes the 16 GB Mac. Tell
  Claude this machine's RAM so it can record a separate budget.
