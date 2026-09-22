#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd -- "$script_dir/.." && pwd -P)"
invocation_directory="$(pwd -P)"
default_port=4173
project_name=""
project_directory_input=""
host_port=""
launcher_only=false
replace_launcher=false

usage() {
  cat <<'USAGE'
Usage: ./scripts/create-new-project.sh [options]

Creates a SquillPad project and a launcher under launchers/. With
--launcher-only, validates an existing project and creates only its launcher.

Options:
  --name NAME                 Project title and launcher-name source
  --directory PATH            Project directory; ~ and relative paths are supported
  --port PORT                 Default host port (0-65535, default: 4173)
  --launcher-only             Do not create or modify project files
  --replace-launcher          Allow replacing an existing launcher (launcher-only)
  -h, --help                  Show this help

The workspace must already have its dependencies installed. Project creation
always runs pnpm build once; future generated-launcher runs use Node directly
and open the authorized host URL automatically.
USAGE
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

prompt_value() {
  local prompt="$1"
  local variable_name="$2"
  local value

  printf '%s' "$prompt"
  if ! IFS= read -r value; then
    fail "Input ended before all project details were provided."
  fi
  printf -v "$variable_name" '%s' "$value"
}

assert_port() {
  local candidate="$1"
  local numeric_value

  if [[ ! "$candidate" =~ ^[0-9]{1,5}$ ]]; then
    fail "Port must be a number from 0 through 65535: $candidate"
  fi
  numeric_value=$((10#$candidate))
  if (( numeric_value > 65535 )); then
    fail "Port must be a number from 0 through 65535: $candidate"
  fi
}

expand_path() {
  local entered_path="$1"

  case "$entered_path" in
    '~')
      [[ -n "${HOME:-}" ]] || fail "HOME is not set, so ~ cannot be expanded."
      printf '%s\n' "$HOME"
      ;;
    '~/'*)
      [[ -n "${HOME:-}" ]] || fail "HOME is not set, so ~ cannot be expanded."
      printf '%s%s\n' "$HOME" "${entered_path:1}"
      ;;
    '~'*)
      fail "Only ~ and ~/path syntax is supported for the project directory."
      ;;
    /*)
      printf '%s\n' "$entered_path"
      ;;
    *)
      printf '%s/%s\n' "$invocation_directory" "$entered_path"
      ;;
  esac
}

slugify() {
  local source="$1"
  local slug

  slug="$(printf '%s' "$source" | LC_ALL=C tr '[:upper:]' '[:lower:]' | LC_ALL=C sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')"
  slug="${slug:0:64}"
  slug="${slug%-}"
  [[ -n "$slug" ]] || slug="project"
  printf '%s\n' "$slug"
}

while (( $# > 0 )); do
  case "$1" in
    --name)
      (( $# >= 2 )) || fail "--name requires a value."
      project_name="$2"
      shift 2
      ;;
    --name=*)
      project_name="${1#*=}"
      shift
      ;;
    --directory)
      (( $# >= 2 )) || fail "--directory requires a value."
      project_directory_input="$2"
      shift 2
      ;;
    --directory=*)
      project_directory_input="${1#*=}"
      shift
      ;;
    --port)
      (( $# >= 2 )) || fail "--port requires a value."
      host_port="$2"
      shift 2
      ;;
    --port=*)
      host_port="${1#*=}"
      shift
      ;;
    --launcher-only)
      launcher_only=true
      shift
      ;;
    --replace-launcher)
      replace_launcher=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown argument: $1"
      ;;
  esac
done

[[ "$replace_launcher" == false || "$launcher_only" == true ]] || \
  fail "--replace-launcher requires --launcher-only."

if [[ -z "$project_name" ]]; then
  prompt_value 'Name of project: ' project_name
fi
if [[ -z "$project_directory_input" ]]; then
  prompt_value 'Directory to save to: ' project_directory_input
fi
if [[ -z "$host_port" ]]; then
  prompt_value "Default host port [$default_port]: " host_port
fi

[[ "$project_name" =~ ^[[:space:]]*$ ]] && fail "Project name cannot be blank."
[[ -n "$project_directory_input" ]] || fail "Project directory cannot be blank."
[[ "$project_name" != *$'\n'* && "$project_name" != *$'\r'* ]] || \
  fail "Project name cannot contain a line break."
[[ "$project_directory_input" != *$'\n'* && "$project_directory_input" != *$'\r'* ]] || \
  fail "Project directory cannot contain a line break."

if [[ "$host_port" == "" ]]; then
  port_response='(blank; used the default 4173)'
  host_port="$default_port"
else
  port_response="$host_port"
fi
assert_port "$host_port"
host_port=$((10#$host_port))

if ! command -v node >/dev/null 2>&1; then
  fail "Node.js was not found. Install Node.js 22.12 or newer and run this script again."
fi
node_version="$(node --version)"
if [[ ! "$node_version" =~ ^v([0-9]+)\.([0-9]+)\. ]]; then
  fail "Could not determine the Node.js version from: $node_version"
fi
node_major="${BASH_REMATCH[1]}"
node_minor="${BASH_REMATCH[2]}"
if (( node_major < 22 || (node_major == 22 && node_minor < 12) )); then
  fail "Node.js 22.12 or newer is required; found $node_version."
fi

project_directory_candidate="$(expand_path "$project_directory_input")"
project_directory="$(node -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' "$project_directory_candidate")"
slug="$(slugify "$project_name")"
launcher_directory="$repo_root/launchers"
launcher_path="$launcher_directory/$slug.sh"
launcher_metadata_path="$launcher_directory/$slug.launcher.json"

if [[ -L "$launcher_directory" || (-e "$launcher_directory" && ! -d "$launcher_directory") ]]; then
  fail "The repository launchers path is not a real directory: $launcher_directory"
fi
mkdir -p -- "$launcher_directory"

if [[ -e "$launcher_path" || -L "$launcher_path" ]] && [[ "$replace_launcher" == false ]]; then
  fail "A launcher already exists at $launcher_path. Use --launcher-only --replace-launcher to replace it explicitly."
fi

if ! command -v pnpm >/dev/null 2>&1; then
  fail "pnpm was not found. Activate pnpm 11 in this terminal, then run this script again."
fi
if [[ ! -d "$repo_root/node_modules" || ! -e "$repo_root/apps/server/node_modules/@squillpad/storage" ]]; then
  fail "Workspace dependencies are missing. Run pnpm install from the repository root, then run this script again."
fi

cd -- "$repo_root"
printf 'Preparing the SquillPad runtime with pnpm build...\n'
pnpm build

if [[ ! -f "$repo_root/apps/server/dist/main.js" || ! -f "$repo_root/apps/web/dist/index.html" ]]; then
  fail "The build completed without producing the server and web runtime artifacts."
fi

if [[ "$launcher_only" == true ]]; then
  (
    cd -- "$repo_root/apps/server"
    SQUILLPAD_PROJECT="$project_directory" node --input-type=module <<'NODE'
import { openProject } from "@squillpad/storage";

const projectRoot = process.env.SQUILLPAD_PROJECT;
if (projectRoot === undefined) throw new Error("Missing project directory");
const session = await openProject(projectRoot);
await session.close();
NODE
  )
else
  (
    cd -- "$repo_root/apps/server"
    SQUILLPAD_PROJECT="$project_directory" \
      SQUILLPAD_PROJECT_TITLE="$project_name" \
      node --input-type=module <<'NODE'
import { createProject } from "@squillpad/storage";

const projectRoot = process.env.SQUILLPAD_PROJECT;
const title = process.env.SQUILLPAD_PROJECT_TITLE;
if (projectRoot === undefined || title === undefined) throw new Error("Missing project details");
const session = await createProject(projectRoot, { title });
await session.close();
NODE
  )
fi

project_directory_literal="$(printf '%q' "$project_directory")"
name_argument="$(printf '%q' "$project_name")"
directory_argument="$(printf '%q' "$project_directory")"
temporary_launcher="$(mktemp "$launcher_directory/.${slug}.XXXXXX")"
temporary_launcher_metadata="$(mktemp "$launcher_directory/.${slug}.metadata.XXXXXX")"

cleanup_temporary_launcher_files() {
  rm -f -- "$temporary_launcher"
  rm -f -- "$temporary_launcher_metadata"
}
trap cleanup_temporary_launcher_files EXIT

{
  printf '%s\n' '#!/usr/bin/env bash' '' '# SquillPad project launcher'
  printf '# Project name: %s\n' "$project_name"
  printf '# Directory entered: %s\n' "$project_directory_input"
  printf '# Resolved project directory: %s\n' "$project_directory"
  printf '# Host port response: %s\n' "$port_response"
  printf '# Default host port: %s\n' "$host_port"
  printf '%s\n' '# LAN sharing: enabled' '# Browser: opens the authorized host URL automatically' '# Git initialization: not requested'
  printf '%s\n' '# Generated by: ./scripts/create-new-project.sh'
  printf '%s\n' '# Recreate this launcher for an existing project (run from repository root):'
  printf '#   ./scripts/create-new-project.sh --launcher-only --replace-launcher --name %s --directory %s --port %s\n' \
    "$name_argument" "$directory_argument" "$host_port"
  printf '# One-run port override: SQUILLPAD_PORT=PORT ./launchers/%s.sh or ./launchers/%s.sh --port PORT\n' \
    "$slug" "$slug"
  printf '%s\n' ''
  cat <<'LAUNCHER_START'
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd -- "$script_dir/.." && pwd -P)"
LAUNCHER_START
  printf 'project_dir=%s\n' "$project_directory_literal"
  printf 'default_port=%s\n' "$host_port"
  cat <<'LAUNCHER_END'
port="${SQUILLPAD_PORT:-$default_port}"
forwarded_args=()

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

usage() {
  printf 'Usage: %s [--port PORT] [server options]\n\n' "$0"
  cat <<'USAGE'
Hosts the recorded SquillPad project over the LAN using the compiled workspace
runtime and opens its authorized URL in the default browser. The project
remains on disk after the host stops.

  --port PORT    Override the recorded port for this run (0-65535)
  -h, --help     Show this help
  --             Stop parsing launcher options and pass the rest to the host

On WSL, Windows PowerShell opens the URL so it reaches the Windows browser.
Native Windows shells use the Windows default-app launcher, macOS uses the
open command, and native Linux uses xdg-open.
USAGE
}

is_wsl() {
  if [[ -n "${WSL_INTEROP:-}" || -n "${WSL_DISTRO_NAME:-}" ]]; then
    return 0
  fi
  [[ -r /proc/version ]] && grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null
}

open_default_browser() {
  local url="$1"
  local platform
  platform="$(uname -s)"

  if is_wsl; then
    if ! command -v powershell.exe >/dev/null 2>&1; then
      printf 'PowerShell was not found; open this URL manually: %s\n' "$url" >&2
      return 1
    fi
    powershell.exe -NoProfile -NonInteractive -Command "Start-Process -FilePath '$url'"
    return
  fi

  case "$platform" in
    Darwin)
      open "$url"
      ;;
    MINGW*|MSYS*|CYGWIN*)
      if command -v cmd.exe >/dev/null 2>&1; then
        cmd.exe /c start "" "$url"
      else
        printf 'The Windows default-app launcher was not found; open this URL manually: %s\n' "$url" >&2
        return 1
      fi
      ;;
    Linux*)
      if command -v xdg-open >/dev/null 2>&1; then
        xdg-open "$url"
      else
        printf 'xdg-open was not found; open this URL manually: %s\n' "$url" >&2
        return 1
      fi
      ;;
    *)
      printf 'No supported default-browser launcher was found; open this URL manually: %s\n' "$url" >&2
      return 1
      ;;
  esac
}

assert_port() {
  local candidate="$1"
  local numeric_value

  if [[ ! "$candidate" =~ ^[0-9]{1,5}$ ]]; then
    fail "Port must be a number from 0 through 65535: $candidate"
  fi
  numeric_value=$((10#$candidate))
  if (( numeric_value > 65535 )); then
    fail "Port must be a number from 0 through 65535: $candidate"
  fi
}

while (( $# > 0 )); do
  case "$1" in
    --port)
      (( $# >= 2 )) || fail "--port requires a value."
      port="$2"
      shift 2
      ;;
    --port=*)
      port="${1#*=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      forwarded_args+=("$@")
      break
      ;;
    *)
      forwarded_args+=("$1")
      shift
      ;;
  esac
done

assert_port "$port"
port=$((10#$port))

if ! command -v node >/dev/null 2>&1; then
  fail "Node.js was not found. Install Node.js 22.12 or newer, then run this launcher again."
fi
node_version="$(node --version)"
if [[ ! "$node_version" =~ ^v([0-9]+)\.([0-9]+)\. ]]; then
  fail "Could not determine the Node.js version from: $node_version"
fi
node_major="${BASH_REMATCH[1]}"
node_minor="${BASH_REMATCH[2]}"
if (( node_major < 22 || (node_major == 22 && node_minor < 12) )); then
  fail "Node.js 22.12 or newer is required; found $node_version."
fi

if [[ -L "$project_dir" || ! -d "$project_dir" || -L "$project_dir/notebook.json" || ! -f "$project_dir/notebook.json" ]]; then
  fail "The recorded project directory is missing or invalid: $project_dir. Regenerate this launcher with --launcher-only after moving the project."
fi
if [[ ! -e "$repo_root/apps/server/node_modules/@squillpad/storage" ]]; then
  fail "Workspace dependencies are missing. Run pnpm install from the repository root, then run this launcher again."
fi
server_entry="$repo_root/apps/server/dist/main.js"
web_root="$repo_root/apps/web/dist"
if [[ ! -f "$server_entry" || ! -f "$web_root/index.html" ]]; then
  fail "Compiled runtime artifacts are missing. Run pnpm build from the repository root, then run this launcher again."
fi

export SQUILLPAD_PROJECT="$project_dir"
export SQUILLPAD_PORT="$port"
host_url_pattern='SquillPad[[:space:]]host:[[:space:]](https?://[^[:space:]]+)'

# Keep the host's output visible while watching it for the authorized URL.
# The host remains in the foreground from the user's perspective and its exit
# status is propagated after the browser has been opened.
set +e
node "$server_entry" "${forwarded_args[@]}" 2>&1 |
(
  host_url=""
  while IFS= read -r line; do
    printf '%s\n' "$line"
    if [[ -z "$host_url" && "$line" =~ $host_url_pattern ]]; then
      host_url="${BASH_REMATCH[1]}"
      if [[ "${SQUILLPAD_OPEN_BROWSER:-1}" == "1" ]]; then
        printf 'Opening SquillPad in the default browser: %s\n' "$host_url" >&2
        if ! open_default_browser "$host_url"; then
          printf 'Open this URL manually: %s\n' "$host_url" >&2
        fi
      fi
    fi
  done
)
pipeline_status=("${PIPESTATUS[@]}")
set -e

exit "${pipeline_status[0]}"
LAUNCHER_END
} > "$temporary_launcher"

node -e '
const fs = require("node:fs");
const [path, launcher, name, projectDirectory, port] = process.argv.slice(1);
fs.writeFileSync(path, `${JSON.stringify({
  schemaVersion: 1,
  launcher,
  name,
  projectDirectory,
  defaultPort: Number(port),
}, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
' "$temporary_launcher_metadata" "$slug.sh" "$project_name" "$project_directory" "$host_port"

chmod 755 "$temporary_launcher"
mv -f -- "$temporary_launcher" "$launcher_path"
mv -f -- "$temporary_launcher_metadata" "$launcher_metadata_path"
trap - EXIT

if [[ "$launcher_only" == true ]]; then
  printf 'Rebuilt launcher: %s\n' "launchers/$slug.sh"
else
  printf 'Created project directory: %s\n' "$project_directory"
  printf 'Created launcher script: %s\n' "launchers/$slug.sh"
fi
printf 'Run: ./launchers/%s.sh\n' "$slug"
