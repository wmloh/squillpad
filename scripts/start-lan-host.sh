#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'USAGE'
Usage: ./scripts/start-lan-host.sh [project-directory]

Builds SquillPad and starts a LAN host. If the project directory does not
exist, a starter project is created there. Existing directories must contain a
SquillPad project and are never overwritten. If omitted, SQUILLPAD_PROJECT
is used; otherwise the default is ../sp-test.

Keep the terminal open. The host prints the authorized URL for client devices.
USAGE
  exit 0
fi

if (( $# > 1 )); then
  printf 'Usage: %s [project-directory]\n' "$0" >&2
  exit 2
fi

if ! command -v pnpm >/dev/null 2>&1; then
  printf 'pnpm was not found. Open a terminal with pnpm 11 available, then run this script again.\n' >&2
  exit 1
fi

project_dir="${1:-${SQUILLPAD_PROJECT:-$repo_root/../sp-test}}"
if [[ "$project_dir" != /* ]]; then
  project_dir="$(pwd)/$project_dir"
fi

project_exists=false
if [[ -L "$project_dir" || -e "$project_dir" ]]; then
  if [[ -L "$project_dir" || ! -d "$project_dir" ]]; then
    printf 'Project path must be a real directory: %s\n' "$project_dir" >&2
    exit 1
  fi

  project_dir="$(cd -- "$project_dir" && pwd -P)"
  if [[ ! -f "$project_dir/notebook.json" ]]; then
    printf 'This does not look like a SquillPad project: %s\n' "$project_dir" >&2
    printf 'The project must contain notebook.json.\n' >&2
    exit 1
  fi
  project_exists=true
fi

cd "$repo_root"
export SQUILLPAD_PROJECT="$project_dir"

printf 'Project: %s\n' "$SQUILLPAD_PROJECT"
printf 'Building SquillPad...\n'
pnpm build

if [[ "$project_exists" == false ]]; then
  printf 'Project does not exist; creating a starter project...\n'
  pnpm --filter @squillpad/server exec tsx -e 'import { createProject } from "@squillpad/storage"; void (async () => { const session = await createProject(process.env.SQUILLPAD_PROJECT!); await session.close(); })();'
fi

printf 'Starting LAN host. Keep this terminal open.\n'
printf 'Use the printed Connect URL on the client device.\n'
exec pnpm --filter @squillpad/server start
