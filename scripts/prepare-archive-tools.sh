#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd "$(dirname "$0")/.." && pwd)"
source_dir="$project_dir/.cache/darc"
revision="c4b9538f173e7a65ae70005772e1bd211c302b93"
patch_file="$project_dir/tools/darc-legacy-time32.patch"
mkdir -p "$project_dir/.cache"
if [[ ! -d "$source_dir" ]]; then
  git clone https://github.com/DavidLee18/DArc.git "$source_dir"
  git -C "$source_dir" checkout --detach "$revision"
fi
if [[ "$(git -C "$source_dir" rev-parse HEAD)" != "$revision" ]]; then
  echo "Unexpected DArc revision in $source_dir; expected $revision." >&2
  exit 1
fi
if git -C "$source_dir" apply --reverse --check "$patch_file" 2>/dev/null; then
  echo 'FreeArc timestamp compatibility patch already applied.'
else
  git -C "$source_dir" apply --check "$patch_file"
  git -C "$source_dir" apply "$patch_file"
fi
cargo +1.95.0 build --release --locked --manifest-path "$source_dir/rust/Cargo.toml" -p darc-unarc
echo "Built $source_dir/rust/target/release/unarc"
echo 'Set DARC_LEGACY_TIME32=1 when reading the supplied FreeArc archive.'
