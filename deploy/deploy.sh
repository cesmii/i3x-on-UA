#!/usr/bin/env bash
#
# deploy.sh: pull, and restart the demo when a new commit changes anything it runs.
# Modelled on the server's CesmiiMigration/deploy.sh. Cron (user cesmii):
#   */3 * * * * /var/www/apps/i3x-on-UA/deploy/deploy.sh
# Prints nothing when there's nothing to do, so cron mails only real deploys and errors.
#
# Restart rule: any change outside Markdown files restarts the service (code, config, NodeSets,
# plant YAML, lockfile). A restart resets the simulation and drops i3X subscriptions, so
# documentation-only commits don't trigger one.

set -euo pipefail
# (here-strings below, not `echo | grep -q`: with pipefail, grep -q's early exit can SIGPIPE the echo and flip the result)

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT="i3x-on-ua"
STAMP_FILE="$DIR/.last-deploy"           # commit the running service was started from (gitignored)
STAMP="[$(date '+%Y-%m-%d %H:%M:%S')]"
cd "$DIR"

LOCK="/tmp/i3x-on-ua-deploy.lock"
if ! mkdir "$LOCK" 2>/dev/null; then exit 0; fi   # previous run still busy (remove the dir if a run was SIGKILLed)
trap 'rmdir "$LOCK"' EXIT

# The server's git-update.sh also pulls every 2 minutes; deciding from the stamp (not from "did this pull
# move HEAD") means a commit pulled by either one is deployed.
git pull --quiet --ff-only || { echo "$STAMP git pull failed"; exit 1; }
HEAD=$(git rev-parse HEAD)
DEPLOYED=$(cat "$STAMP_FILE" 2>/dev/null || true)

if [ "$DEPLOYED" = "$HEAD" ] && systemctl is-active --quiet "$UNIT"; then exit 0; fi

BASE=""
if [ -n "$DEPLOYED" ] && git cat-file -e "${DEPLOYED}^{commit}" 2>/dev/null; then BASE="$DEPLOYED"; fi
CHANGED=$( [ -n "$BASE" ] && git diff --name-only "$BASE" "$HEAD" || echo "(first deploy)" )

if [ -n "$BASE" ] && systemctl is-active --quiet "$UNIT" && ! grep -qv '\.md$' <<< "$CHANGED"; then
    echo "$HEAD" > "$STAMP_FILE"
    echo "$STAMP ${BASE:0:7} → ${HEAD:0:7}: documentation only, no restart."
    exit 0
fi

echo "$STAMP Deploying ${HEAD:0:7}${BASE:+ (was ${BASE:0:7})}."
[ -f .env ] || cp .env.example .env
if [ ! -d node_modules ] || [ -z "$BASE" ] || grep -q '^package-lock\.json$' <<< "$CHANGED"; then
    # cron's PATH may not have npm (nvm installs): use the npm that sits next to the resolved node
    NPM=$(command -v npm 2>/dev/null || true)
    if [ -z "$NPM" ]; then NODE=$(command -v node) && NPM="$(dirname "$(readlink -f "$NODE")")/npm"; fi
    echo "$STAMP npm ci…"
    PATH="$(dirname "$(readlink -f "$(command -v node)")"):$PATH" "$NPM" ci --no-audit --no-fund --loglevel=error
fi

sudo -n systemctl restart "$UNIT"
echo "$HEAD" > "$STAMP_FILE"
echo "$STAMP Restarted $UNIT on ${HEAD:0:7}."
