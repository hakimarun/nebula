# NEBULA — self-hosted media server

Your NAS becomes a streaming service: movies, series, music and photos with a
Netflix-style UI, metadata & trailers from TMDB, per-user accounts, watch
progress, intro-skip, trending charts, email notifications and backups.

## Run

```
npm install          # server deps (first time only)
cd client && npm install && npm run build && cd ..   # build UI (first time only)
node server/index.js
```

Open **http://localhost:8474** — the setup wizard walks you through library
folders, TMDB key, accounts and email. Port can be changed with the
`NEBULA_PORT` env var; data location with `NEBULA_DATA` (default `./data`).

To develop the UI with hot reload: `cd client && npm run dev` (proxies to :8474).

## Run with Docker (QNAP Container Station)

A prebuilt image (Linux **ffmpeg/ffprobe** + **yt-dlp** bundled, web UI built in)
is published to **GitHub Container Registry** by CI on every push to `main`, for
`linux/amd64` and `linux/arm64`. QNAP Container Station just pulls it — no build
context needed, which is why the earlier `build: .` paste failed.

**On the QNAP:**

1. **Log in to ghcr once** so the NAS can pull the private image
   (Container Station → Registry → add a `ghcr.io` registry, or on a shell):
   ```
   docker login ghcr.io -u hakimarun     # paste a PAT with the read:packages scope
   ```
   *(Alternatively make the package public on GitHub → Packages → nebula →
   Package settings → Change visibility, then no login is needed.)*
2. Container Station → **Create Application** → paste `docker-compose.yml` →
   **Create**. QNAP gives the container its own LAN IP and the app listens on
   **port 80** → open `http://<container-ip>/` and finish the setup wizard.
3. Mount your media: uncomment `- /share/Multimedia:/media:ro` in the compose,
   then set the app's **Library folders** to `/media/...`.
4. Data (database, secret, cache, downloads) lives in the `nebula-data` volume
   and survives updates/recreates.

> First time: the image only exists after the **build-and-push** GitHub Action
> finishes (repo → Actions tab). Give it a few minutes after the first push.

**Updating** — the compose uses `pull_policy: always`, so recreating the
container pulls the newest image (CI rebuilds it on every push to `main`).
Optionally set `AUTO_UPDATE=true` + `REPO_URL` + a read-only `GITHUB_TOKEN` to
also `git pull` the latest code on every start without waiting for a rebuild.

**Build on the NAS instead** (no registry, needs SSH): clone the repo to a share
and use the commented `build: .` service in `docker-compose.yml`, then
`docker compose up -d --build`.

**DLNA / casting / `nebula.local`** rely on LAN multicast. If discovery doesn't
work through the bridge network, switch to host networking (see the commented
`network_mode: host` in `docker-compose.yml`).

## Features

- **Library sync** — point it at local folders or mounted network shares
  (`\\NAS\media\movies`, `Z:\series`, …). Rescans on a configurable interval.
  Naming: movies `Title (Year).mkv`; series `Show Name/Season 01/Show.S01E01.mkv`;
  music `Artist/Album/01 - Track.mp3`; photos any folder structure.
- **Metadata** — with a free [TMDB](https://www.themoviedb.org/settings/api) key:
  covers, backdrops, descriptions, YouTube trailers, reviews, certifications,
  per-episode titles/stills, similar-title suggestions, weekly trending +
  a "Top 10 on your server" row comparing trending titles against your NAS.
- **Custom player** — seek/volume/speed/fullscreen, sidecar subtitles
  (`.srt`/`.vtt`, auto-converted, language auto-detected), remembers progress,
  next-episode button + autoplay, **Skip Intro**: the player learns from
  forward-seeks across episodes and auto-places intro markers (manual override
  per series/season in the title's detail view).
- **External streams** — add titles that play from YouTube, Vimeo, Dailymotion,
  Streamtape or any direct URL. Music from YouTube / Spotify / SoundCloud.
- **Uploads** — drag & drop movies, episodes (with series/season routing),
  music and photos straight into your library from the browser.
- **Accounts** — optional. Admin/user roles with granular permissions
  (upload, edit, delete, music, photos, users, settings). JWT-based, self
  registration optional.
- **Email** — SMTP notifications when new media lands, test mail + send log.
- **Backups** — one-click zip of the database (library index, users, progress,
  settings), download, restore from list or uploaded file.
- **Customization** — accent color (hue wheel + presets), app name, EN/DE
  locale, card size, row order, hero/top-10 toggles, watched threshold,
  autoplay & auto-skip, and a raw JSON editor for everything else.

## Power features

- **Transcoding (ffmpeg)** — incompatible files (MKV/AVI, HEVC, DTS…) are converted
  to HLS on the fly; quality capping, audio-track selection, embedded-subtitle
  extraction, seek-bar hover previews and generated thumbnails. ffmpeg is bundled
  in `tools/ffmpeg` (or set a custom path in Settings → Library).
- **Audio intro detection** — episodes of a season are audio-fingerprinted; the
  shared intro segment becomes a Skip-Intro marker automatically (plus the
  existing seek-behaviour learning and manual markers).
- **Watchlist** — mark titles on the trending row; you get a toast + email when
  they appear on your NAS.
- **Profiles** — Netflix-style "Who's watching?" without passwords; kids profiles
  hide R/TV-MA/16+ titles and lock settings (Settings → Users).
- **Watch together** — start a room in the player, share the 5-letter code,
  playback stays in sync.
- **OpenSubtitles** — automatic subtitle search/download (free API key,
  Settings → Playback).
- **DLNA** (experimental) — browse the library from smart TVs (Settings → Advanced;
  note: DLNA has no login).
- **More**: live scan progress + new-media toasts (SSE), instant rescan via
  folder watching, ID3 tags + album view + queue/shuffle, photo thumbnails,
  statistics dashboard, TMDB image disk cache, fix-match dialog, filename
  cleanup, scheduled backups with retention, login rate-limiting, PWA install,
  optional HTTPS (`NEBULA_TLS_CERT`/`NEBULA_TLS_KEY`).

## Layout

```
server/   Express API (Node ≥22.5, built-in node:sqlite — no native deps)
client/   React + Vite frontend (built to client/dist, served by the server)
data/     created at runtime: nebula.db, backups/, upload-tmp/
```
