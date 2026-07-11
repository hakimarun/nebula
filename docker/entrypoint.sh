#!/bin/sh
# NEBULA container entrypoint:
#   1) optionally self-update from the (private) GitHub repo,
#   2) make sure dependencies + the web client build exist,
#   3) start the server.
set -e
cd /app

log() { echo "[nebula] $*"; }

# ---- 1) self-update ---------------------------------------------------------
# Enabled when AUTO_UPDATE != "false", a .git checkout is present, and REPO_URL
# is set. For a PRIVATE repo, also provide GITHUB_TOKEN (a fine-grained PAT with
# read-only "Contents" access). If the check fails (offline / no access), the
# container simply keeps running the version baked into the image.
if [ "${AUTO_UPDATE:-true}" != "false" ] && [ -d .git ] && [ -n "${REPO_URL:-}" ]; then
  log "checking for updates from ${REPO_URL} ..."
  remote="$REPO_URL"
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    remote="$(printf '%s' "$REPO_URL" | sed "s#https://#https://${GITHUB_TOKEN}@#")"
  fi
  git config --global --add safe.directory /app 2>/dev/null || true
  git remote set-url origin "$remote" 2>/dev/null || git remote add origin "$remote"
  branch="${REPO_BRANCH:-main}"
  before="$(git rev-parse HEAD 2>/dev/null || echo none)"
  if git fetch --depth 1 origin "$branch" >/dev/null 2>&1 && git reset --hard "origin/${branch}" >/dev/null 2>&1; then
    after="$(git rev-parse HEAD 2>/dev/null || echo none)"
    if [ "$before" != "$after" ]; then
      log "updated ${before} -> ${after}; reinstalling dependencies + rebuilding client"
      npm install --omit=dev
      npm run build
    else
      log "already up to date (${after})"
    fi
  else
    log "update check failed (offline or no repo access) — continuing with current version"
  fi
  # scrub the tokenised remote so the token isn't left on disk
  git remote set-url origin "$REPO_URL" 2>/dev/null || true
fi

# ---- 2) first-run safety net ------------------------------------------------
[ -d node_modules ] || { log "installing dependencies"; npm install --omit=dev; }
[ -f client/dist/index.html ] || { log "building web client"; npm run build; }

# ---- 3) start ---------------------------------------------------------------
# node:sqlite needs --experimental-sqlite on Node < 24; on newer it's built in.
if node -e "require('node:sqlite')" >/dev/null 2>&1; then
  log "starting NEBULA on port ${NEBULA_PORT:-80}"
  exec node server/index.js
else
  log "starting NEBULA (--experimental-sqlite) on port ${NEBULA_PORT:-80}"
  exec node --experimental-sqlite server/index.js
fi
