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

The image bundles Linux **ffmpeg/ffprobe** and **yt-dlp**, builds the web UI,
and can **self-update from this repo on every start**.

```
git clone https://github.com/YOUR_GITHUB_USER/nebula.git
cd nebula
cp .env.example .env        # optional: set REPO_URL + GITHUB_TOKEN for auto-update
docker compose up -d --build
```

QNAP Container Station gives the container its own IP on the LAN, so the app
listens on **port 80** — open `http://<container-ip>/` and finish the setup
wizard.

**On the QNAP:**

1. Copy this repo to a share, e.g. `/share/Container/nebula`.
2. Container Station → **Create Application** → paste `docker-compose.yml`
   (or point it at the folder) → **Create**.
3. Mount your media: uncomment the `- /share/Multimedia:/media:ro` volume in
   `docker-compose.yml`, then set the app's **Library folders** to `/media/...`.
4. Data (database, secret, cache, downloads) lives in the `nebula-data` volume
   and survives updates/rebuilds.

**Automatic updates** — with `REPO_URL` + a read-only `GITHUB_TOKEN` in `.env`,
the container fetches the latest commit on start, reinstalls dependencies,
rebuilds the UI and launches. Without them it just runs the built-in version.
Recreate the container (or restart it) to pull the newest code.

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
