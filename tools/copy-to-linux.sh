#!/usr/bin/env bash
# Copies this checkout to a Linux machine over SSH. The copy includes the git
# history and every local branch, the ignored original data (game install,
# Reference/, .cache/, reports/), the CrossOver bottle's game folder and Claude
# Code's project memory. Machine-specific files are left out; docs/linux-host.md
# rebuilds them on the other side.
#
#   tools/copy-to-linux.sh user@host [/absolute/remote/dir]   (default ~/deus_ex_web)
#
# Rerun after an interruption: rsync sends only what is missing. Once a run
# completes, the script refuses to run again, so it never overwrites work done
# on the Linux side. From then on, move changes with git. To force another
# run, delete .git/copied-from-mac on the Linux side. That run overwrites any
# Linux file that also exists on the Mac with different contents.
set -euo pipefail

host=${1:?usage: tools/copy-to-linux.sh user@host [/absolute/remote/dir]}
root=$(cd "$(dirname "$0")/.." && pwd)
remote_home=$(ssh "$host" 'printf %s "$HOME"')
# A login script that prints would corrupt every remote path below.
[[ $remote_home == /* && $remote_home != *$'\n'* ]] \
  || { echo "unexpected remote \$HOME: $remote_home" >&2; exit 1; }
dest=${2:-$remote_home/deus_ex_web}
[[ $dest == /* ]] || { echo "remote dir must be absolute: $dest" >&2; exit 1; }
prefix=$remote_home/.wine-deusex
bottle="$HOME/Library/Application Support/CrossOver/Bottles/DeusEx/drive_c"
# Claude Code keys project memory by the project path with every
# non-alphanumeric character replaced by '-'.
slug() { printf %s "$1" | sed 's/[^A-Za-z0-9]/-/g'; }
memory="$HOME/.claude/projects/$(slug "$root")/memory"
remote_memory="$remote_home/.claude/projects/$(slug "$dest")/memory"
marker=.git/copied-from-mac

if ssh "$host" "test -e '$dest/$marker'"; then
  echo "$host:$dest already holds a completed copy; move work with git instead." >&2
  exit 1
fi

# Worktrees hold absolute gitdir pointers to this Mac. Leave them out;
# 'git worktree prune' on the Linux side drops their entries.
excludes=()
while read -r _ tree; do
  [[ $tree == "$root" ]] || excludes+=(--exclude="/${tree#"$root"/}/")
done < <(git -C "$root" worktree list --porcelain | grep '^worktree ')

excludes+=(
  --exclude=/.claude/worktrees/ --exclude=node_modules/ --exclude=.DS_Store --exclude=__pycache__/
  # Built for macOS or tied to its paths; rebuilt on Linux.
  --exclude=/.cache/native-probe-env/ --exclude=/.cache/wasm/
  --exclude='/.cache/commit-snapshot.*/' --exclude='/native/*/target/'
  --exclude=/dist/ --exclude=/test-results/
  # Mac-only work: perf traces (the 120 fps target is measured on the M2 Pro)
  # and the ad capture pipeline (hard-wired to the CrossOver bottle path).
  --exclude=/.cache/perf/ --exclude=/.work/logs/ --exclude=/.work/replay/sess/
  --exclude=/ad/build/ --exclude=/ad/captures/ --exclude=/ad/out/
  # Empty fallback install location; tools find 'Deus Ex GOTY Edition/' first.
  --exclude=/game/
)

sync() { rsync -a --partial --human-readable --info=progress2 "$@"; }

echo "== project -> $host:$dest"
ssh "$host" "mkdir -p '$dest'"
# --safe-links skips symlinks that point outside the tree (absolute links to
# this Mac would arrive dangling).
sync --safe-links "${excludes[@]}" "$root/" "$host:$dest/"

# The bottle's install is the project's install plus its own .ini files,
# saves and dump tools. --copy-dest takes the unchanged files from the copy
# made above, so only the differences cross the network.
echo "== CrossOver game folder -> $host:$prefix/drive_c"
ssh "$host" "mkdir -p '$prefix/drive_c'"
sync --exclude=.DS_Store --copy-dest="$dest/Deus Ex GOTY Edition/" \
  "$bottle/Deus Ex GOTY Edition/" "$host:$prefix/drive_c/Deus Ex GOTY Edition/"
sync "$bottle/dxad/" "$host:$prefix/drive_c/dxad/"

echo "== Claude memory -> $host:$remote_memory"
ssh "$host" "mkdir -p '$remote_memory'"
sync "$memory/" "$host:$remote_memory/"

ssh "$host" "cd '$dest' && git worktree prune && git config core.ignorecase false \
  && git config --unset core.precomposeunicode; date > '$marker'"
echo "Done. Continue with docs/linux-host.md on $host."
