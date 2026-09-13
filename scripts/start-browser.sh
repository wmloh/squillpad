#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
host_script="$script_dir/start-lan-host.sh"

usage() {
  cat <<'USAGE'
Usage: ./scripts/start-browser.sh [project-directory]

Starts the LAN host and opens the authorized SquillPad host URL in the
default browser. The project-directory argument follows start-lan-host.sh;
if omitted, SQUILLPAD_PROJECT is used, then ../sp-test.

On WSL, Windows PowerShell opens the URL so it reaches the Windows browser.
Native Windows shells use the Windows default-app launcher, macOS uses the
open command, and native Linux uses xdg-open. Keep the terminal open while
the host is running.
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

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

if [[ ! -x "$host_script" ]]; then
  printf 'Host starter is missing or not executable: %s\n' "$host_script" >&2
  exit 1
fi

host_url_pattern='SquillPad[[:space:]]host:[[:space:]](https?://[^[:space:]]+)'

# Keep the host's output visible while watching it for the authorized URL.
# The host remains in the foreground from the user's perspective and its exit
# status is propagated after the browser has been opened.
set +e
bash "$host_script" "$@" 2>&1 |
(
  host_url=""
  while IFS= read -r line; do
    printf '%s\n' "$line"
    if [[ -z "$host_url" && "$line" =~ $host_url_pattern ]]; then
      host_url="${BASH_REMATCH[1]}"
      printf 'Opening SquillPad in the default browser: %s\n' "$host_url" >&2
      if ! open_default_browser "$host_url"; then
        printf 'Open this URL manually: %s\n' "$host_url" >&2
      fi
    fi
  done
)
pipeline_status=("${PIPESTATUS[@]}")
set -e

exit "${pipeline_status[0]}"
