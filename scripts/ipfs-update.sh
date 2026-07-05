#!/usr/bin/env bash
#
# ipfs-update.sh — safely pull the latest ipfs-gate code and rebuild.
#
# Why this exists: nginx/ipfs-gate.conf is the ONLY git-tracked file operators
# customize per-deployment (.env and data/ are gitignored, so `git reset --hard`
# never touches them). A bare `git fetch --all && git reset --hard origin/main`
# wipes that file back to its unconfigured placeholder (wrong server_name, HTTPS
# server block commented out) and takes the site down. See WalkThrough.wiki
# "Common problems" for the incident this script was written after.
#
# This script backs the file up, resets, restores it, validates the restored
# config against the real container mounts BEFORE touching the running stack,
# and only then rebuilds. Safe to re-run; exits cleanly if already up to date.
#
# Usage: ipfs-update.sh
# Override for reuse on another instance: REPO_DIR=... DOMAIN=... ipfs-update.sh

set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/IPFS-Gate}"
DOMAIN="${DOMAIN:-ipfs.v4call.com}"
NGINX_CONF="nginx/ipfs-gate.conf"
LOG_FILE="${LOG_FILE:-/var/log/ipfs-update.log}"
LOCK_FILE="${LOCK_FILE:-/var/lock/ipfs-update.lock}"

log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG_FILE"; }
fail() { log "ABORT: $*"; exit 1; }

# Refuse to run a second update while one is already in flight — an
# overlapping git reset / docker rebuild would race the first run.
exec 200>"$LOCK_FILE"
flock -n 200 || fail "another ipfs-update.sh is already running (lock: $LOCK_FILE)"

cd "$REPO_DIR"

log "=== ipfs-update starting (repo=$REPO_DIR domain=$DOMAIN) ==="

BEFORE_COMMIT=$(git rev-parse --short HEAD)
log "current commit: $BEFORE_COMMIT"

[ -f "$NGINX_CONF" ] || fail "$NGINX_CONF not found — wrong REPO_DIR?"

# Refuse to reset if there are local changes we don't already know how to
# protect. Only nginx/ipfs-gate.conf is expected to differ from git; anything
# else is unexpected operator state that a hard reset would silently destroy.
UNEXPECTED=$(git status --porcelain | grep -v '^??' | awk '{print $2}' | grep -v -x "$NGINX_CONF" || true)
if [ -n "$UNEXPECTED" ]; then
  log "local changes present outside $NGINX_CONF:"
  echo "$UNEXPECTED" | tee -a "$LOG_FILE"
  fail "refusing to reset — review/stash these manually first"
fi

# Back up the operator-customized nginx config (git reset --hard wipes it)
BACKUP="/root/nginx-ipfs-gate.conf.bk-$(date -u +%Y%m%dT%H%M%SZ)"
cp "$NGINX_CONF" "$BACKUP"
log "backed up $NGINX_CONF -> $BACKUP"

log "fetching origin/main..."
git fetch --all --quiet

AFTER_COMMIT=$(git rev-parse --short origin/main)
if [ "$BEFORE_COMMIT" = "$AFTER_COMMIT" ]; then
  log "already up to date at $BEFORE_COMMIT — nothing to pull, no rebuild needed."
  rm -f "$BACKUP"
  log "=== ipfs-update finished (no-op) ==="
  exit 0
fi

log "resetting $BEFORE_COMMIT -> $AFTER_COMMIT..."
git reset --hard origin/main --quiet

log "restoring operator nginx config from backup..."
cp "$BACKUP" "$NGINX_CONF"

# Validate the restored config against the REAL container mounts (same
# volumes as the live service) before touching anything running. If this
# fails, nothing has been torn down yet — old containers are untouched.
log "validating nginx config against live mounts..."
if ! docker compose run --rm --no-deps -T nginx nginx -t 2>&1 | tee -a "$LOG_FILE"; then
  fail "nginx config failed validation after restore — running containers untouched. Check $BACKUP."
fi

# Build while the old containers are still serving traffic — build doesn't
# touch running containers, so this minimizes the actual downtime window.
log "building (--no-cache)..."
docker compose build --no-cache

log "recreating containers..."
docker compose down
docker compose up -d

log "waiting for containers to settle..."
sleep 8
docker compose ps | tee -a "$LOG_FILE"

log "checking https://$DOMAIN/ ..."
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$DOMAIN/" || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
  log "SUCCESS: https://$DOMAIN/ returned 200. Now on commit $(git rev-parse --short HEAD)."
else
  log "FAILURE: https://$DOMAIN/ returned $HTTP_CODE. Check 'docker compose logs' before walking away."
  exit 1
fi

log "=== ipfs-update finished ==="
