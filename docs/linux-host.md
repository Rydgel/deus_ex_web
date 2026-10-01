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
sudo pacman -S --needed git wine mingw-w64-gcc python nodejs npm
```

Rust comes from rustup (pacman's `rustup`, or the rustup.rs installer, which
puts it in `~/.cargo/bin`). Use the same stable release as the Mac (1.99.0 on
2026-10-01) and add the wasm target:

```bash
rustup default stable
rustup target add wasm32-unknown-unknown
```

With the same compiler, `script-vm.wasm` comes out byte-identical to the Mac
build. `lodmesh-kernel.wasm` differs in one string only: the path of a standard
library file inside a panic message. The Mac has rustup's `rust-src` component,
so rustc writes the local path there. A Mac build with
`--remap-path-prefix=<rust-src>=/rustc/<commit>` gives the identical file
(checked 2026-10-01).

Two wasm32 linker defaults changed after 1.95.0. Undeclared `extern "C"`
functions no longer become `env` imports: 1.98.1 and 1.99.0 fail the link
(fixed in commit 04860d7). `__heap_base` and `__data_end` are no longer
exported: checked on 1.99.0 (fixed in commit 17257df). The source now declares both explicitly. 1.95.0 still builds
the same bytes as before.

If pacman reports `target not found: wine`, uncomment `[multilib]` in
`/etc/pacman.conf` and run `sudo pacman -Sy`. Any Node ≥ 22.12 satisfies
`package.json`. The Mac runs 26.8.2 and the Linux machine 26.8.1. Keep the same
major version to avoid V8 differences.

## 4. Project setup (in the project directory)

```bash
npm ci
npm run build:wasm
npx playwright install chromium
python -m venv .cache/native-probe-env
.cache/native-probe-env/bin/pip install capstone==5.0.9 unicorn==2.1.4
WINEDLLOVERRIDES="mscoree,mshtml=" WINEPREFIX=~/.wine-deusex wineboot -u
```

If Chromium later fails with a missing shared library, install
`sudo pacman -S --needed nss atk at-spi2-core libcups libdrm libxkbcommon mesa alsa-lib pango cairo gtk3`.
Playwright's `--with-deps` does not support Arch, and it downloads its Ubuntu
24.04 build instead. The `WINEDLLOVERRIDES` setting skips the Mono and Gecko
prompts, which the probes do not need.

Add to `~/.bashrc`. Omarchy's `.bashrc` returns early in non-interactive
shells, so scripts run over SSH must export these themselves:

```bash
export NATIVE_PROBE_PYTHON=$HOME/projects/deus_ex_web/.cache/native-probe-env/bin/python
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
node scripts/validate-x87-nan-hardware.mjs
npm run validate -- --jobs 8 --mem-budget 16384
```

The Mac sweeps with the AGENTS.md default of 4 jobs. This machine has room
for more (the user agreed on 2026-10-01): the runner's default memory budget
is min(8 GiB, RAM/2), which would hold the 3–4 GB validators back, so pass a
larger one with the extra jobs.

## Validator baseline (2026-10-01)

First full sweep on this machine, master `e21924c`, 4 jobs: 448 of 450
passed in 1115 s wall (4261 s CPU, speedup 3.8×). The largest validators
peaked at 4.0 GB (stage3-training-conformance) and 3.9 GB
(player-tick-order); the slowest were gpu-mesh (480 s) and
stage3-training-conformance (362 s). The two failures:

- `validate-script-vm-interp`: the x86 NaN mismatch below, now fixed.
- `validate-gpu-mesh`: not the `--use-angle=metal` flag. Chromium ignores
  that ANGLE backend on Linux and the validator ran through to its Island
  admission phase, where the game paused on `Non-Pawn performPhysics
  physProjectile (0x103d4600) is not linked for deusex.tracer`: the open
  Tracer projectile boundary (terrorists firing at the bots), which that
  phase hits on any new Island pause. The flag still means the Mac and
  Linux runs use different ANGLE backends.

Every other validator, including the four hardware-x87 ones under wine
11.17, passed here as on the Mac.

The sweep after the NaN fix ran with `--jobs 8 --mem-budget 16384`: 449 of
450 passed in 720 s wall (5758 s CPU, speedup 8.0×), the remaining failure
being the same `validate-gpu-mesh` Tracer pause.

## Known gaps

- **Display freeze with a visible Play window (2026-10-01).** Opening the dev
  server (127.0.0.1:5173) in Chromium froze the whole screen. The machine stayed
  reachable over SSH, but only a reboot recovered it. The kernel log shows
  `nvidia-modeset/kthread_q` spinning in the display-idle prefetch
  (`DifrPrefetchEventDeferredWork -> nvDIFRPrefetchSurfaces`) and Hyprland
  blocked in `ApplyModeSetConfig` on its lock, with no Xid error. The external
  monitor (HDMI-A-1) is driven by the RTX (`card1`); the laptop panel (eDP-2)
  by the AMD iGPU. This is a driver bug in nvidia-open 610.57.04, the latest
  in the repos on 2026-10-01, and no driver option disables DIFR. Headless
  runs (validators, Playwright) are unaffected. Workaround: switch the ASUS
  platform profile to `performance` (`powerprofilesctl set performance`).
  The RTX then holds P0 (about 14 W instead of 2 W in P8), and Play ran in a
  visible window without freezing. That is one good run against one freeze
  in `balanced`, so the workaround is not proven. Driving the external
  monitor from the AMD GPU (a USB-C DisplayPort output on `card2`) should
  also avoid it, but is untested.

- **D3D control word.** Wine is still in between here, as it is with CrossOver.
  A `DDSCL_FPUSETUP` control word measured under wine shows wine's
  reimplementation (wined3d), not Microsoft's. Only a Windows install can
  settle that question.
- **x87 vendor.** On 2026-10-01 all four hardware-x87 validators passed on the
  AMD machine under wine 11.17 (control word 0x037f). That includes
  validate-x87-transcendental-hardware, where 1,200,084 sin/cos/tan/atan results
  for |x| < 2^26 matched bit-exact. Inputs above 2^26 are refused, as on the
  Mac. A future disagreement would still be a finding to investigate, because
  the original game ran on both Intel and AMD CPUs.
- **NaN results (fixed 2026-10-01).** `validate-script-vm-interp` failed on
  this machine and passed on the Mac: it hard-coded arm64's default NaN
  `0x7FC00000` for `inf * 0`, and both VMs left NaN results to the host FPU,
  so on x86 they stored `0xFFC00000`. The original's x87 bodies store the
  real indefinite `0xFFC00000` on every CPU, and keep the larger
  significand of a NaN pair (the positive NaN on a tie), where the VMs kept
  the first NaN operand. Both VMs now build the x87's NaN explicitly
  (`src/runtime/x87-nan.mjs`, `interp.rs` `x87_nan`), measured on the
  original bodies and on this machine's x87
  (docs/script-float-vector-operators.md, "Host-arithmetic operators").
- `scripts/validate-gpu-mesh.mjs` always launches Chromium with
  `--use-angle=metal`, which exists only on macOS; Linux Chromium ignores it
  and uses its default backend, so the GPU path runs on a different ANGLE
  backend than on the Mac.
- `ad/scripts/original-game.mjs` hard-codes the CrossOver bottle path under
  `~/Library`. The ad capture pipeline stays on the Mac.
- The `.work/tools` perf scripts hard-code `/Users/gcc` paths. Performance
  work stays on the Mac.
- The validator runner reads memory pressure on macOS only. On Linux only its
  per-validator RSS cap applies.
- Claude Code's `machine-memory-budget` note describes the 16 GB Mac. Tell
  Claude this machine's RAM so it can record a separate budget.
