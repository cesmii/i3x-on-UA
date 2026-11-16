#!/usr/bin/env bash
# i3x-on-OPC: one-step start for macOS, Linux and WSL.
#
#   ./start.sh                start the OPC UA plant + the gateways enabled in compare/gateways.yaml + front door
#   ./start.sh status         side-by-side status of the running gateways
#   ./start.sh conformance    i3X conformance suite against each running gateway
#   ./start.sh --help
#
# First run: checks Node, installs dependencies (npm ci) if needed, creates .env from .env.example,
# generates the plant NodeSet if missing, and makes sure Docker is up when a Docker gateway is enabled.
# Settings: .env (simulation, interpretation switches) · compare/gateways.yaml (ports, gateways, active).
# Ctrl-C stops everything the launcher started.
# macOS's login shell is zsh: if this was started as `zsh start.sh` or `sh start.sh`, re-run it with bash
# (every Mac ships /bin/bash; the script also sticks to bash 3.2 features for that reason).
if [ -z "${BASH_VERSION:-}" ]; then exec bash "$0" "$@"; fi
set -euo pipefail
cd "$(dirname "$0")"

say()  { printf '\033[1;34m[start]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[start]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[start]\033[0m %s\n' "$*" >&2; exit 1; }

case "${1:-up}" in
  -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  up|status|conformance) CMD="${1:-up}" ;;
  *) die "unknown command '$1' (try: ./start.sh --help)" ;;
esac

# ---------------------------------------------------------------- platform
PLATFORM=linux
if [ "$(uname -s)" = Darwin ]; then PLATFORM=mac
elif grep -qi microsoft /proc/version 2>/dev/null; then PLATFORM=wsl; fi
say "platform: $PLATFORM"
if [ "$PLATFORM" = wsl ]; then
  case "$(pwd)" in /mnt/*) warn "project is on a Windows drive ($(pwd)); npm and file watching are much faster inside the WSL filesystem (e.g. ~/i3x-on-OPC)." ;; esac
fi

# ---------------------------------------------------------------- node / npm
command -v node >/dev/null 2>&1 || die "Node.js not found. Install Node 24 LTS, e.g. with nvm: https://github.com/nvm-sh/nvm  (nvm install 24)"
if [ "$PLATFORM" = wsl ]; then
  case "$(command -v node)" in /mnt/*) die "WSL is using the Windows node ($(command -v node)); install Node inside WSL (nvm install 24)." ;; esac
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node $(node -v) is too old; need 20 or newer (tested with 24)."
[ "$NODE_MAJOR" -ge 24 ] || warn "Node $(node -v) should work, but this project is tested with Node 24."
command -v npm >/dev/null 2>&1 || die "npm not found (it ships with Node.js)."

# ---------------------------------------------------------------- dependencies
if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  say "installing dependencies (npm ci)…"
  npm ci --no-audit --no-fund
else
  say "dependencies up to date"
fi

# ---------------------------------------------------------------- environment / config
if [ ! -f .env ]; then
  cp .env.example .env
  say "created .env from .env.example (edit .env for simulation settings and interpretation switches)"
fi
set -a
# shellcheck disable=SC1091
. ./.env
set +a
[ -f compare/gateways.yaml ] || die "compare/gateways.yaml is missing (it ships with the project)."

if [ ! -f nodesets/factory/BeverageFactory.NodeSet2.xml ] || [ ! -f nodesets/factory/ISA95Operations.NodeSet2.xml ]; then
  say "generating the plant NodeSet…"
  npm run --silent generate -w factory
fi

# ---------------------------------------------------------------- docker (only when an enabled gateway needs it)
DOCKER_NEEDED="$(node --input-type=module -e "
  import fs from 'node:fs'; import { parse } from 'yaml';
  const c = parse(fs.readFileSync('compare/gateways.yaml', 'utf8'));
  console.log(Object.values(c.gateways).some((g) => g.enabled && g.kind === 'docker') ? 1 : 0);")"

if [ "$CMD" = up ] && [ "$DOCKER_NEEDED" = 1 ]; then
  if ! command -v docker >/dev/null 2>&1; then
    warn "Docker is not installed: Docker-based gateways will be skipped (set enabled: false in compare/gateways.yaml to silence this)."
  elif ! docker info >/dev/null 2>&1; then
    case "$PLATFORM" in
      mac)
        if [ "${AUTO_START_DOCKER:-1}" = 1 ] && [ -d /Applications/Docker.app ]; then
          say "starting Docker Desktop…"
          open -a Docker
          for _ in $(seq 1 90); do docker info >/dev/null 2>&1 && break; sleep 2; done
          docker info >/dev/null 2>&1 && say "Docker is up" || warn "Docker did not come up in 3 minutes; Docker-based gateways will be skipped."
        else
          warn "Docker is not running: start Docker Desktop (or your Docker runtime) to include Docker-based gateways."
        fi ;;
      wsl)
        warn "Docker is not reachable from WSL: start Docker Desktop on Windows and enable Settings → Resources → WSL integration for this distro." ;;
      *)
        if docker info 2>&1 | grep -qi 'permission denied'; then
          warn "No permission to use Docker: run 'sudo usermod -aG docker \$USER' and log in again (or use rootless Docker)."
        else
          warn "Docker is not running: 'sudo systemctl start docker' to include Docker-based gateways."
        fi ;;
    esac
  fi
fi

# ---------------------------------------------------------------- go
# Run the launcher as this very process (exec, tsx loaded in-process): Ctrl-C then reaches it directly, with no
# npm/tsx wrapper processes in between that could forward a second Ctrl-C and force-kill it mid-cleanup.
say "launcher: $CMD"
exec node --import tsx compare/src/launch.ts "$CMD"
