# NEBULA — self-hosted media server. Runtime image for QNAP Container Station
# (and any Docker host). Bundles Linux ffmpeg/ffprobe + yt-dlp and can
# self-update from the source repo on start (see docker/entrypoint.sh).
FROM node:24-bookworm-slim

# --- system dependencies -----------------------------------------------------
#  ffmpeg/ffprobe : transcoding, thumbnails, audio intro detection
#  git            : self-update on start
#  yt-dlp         : offline downloads of external streams
#  tini           : proper PID 1 / signal handling
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg git ca-certificates tini curl \
 && arch="$(dpkg --print-architecture)" \
 && case "$arch" in \
      amd64) yt="yt-dlp_linux" ;; \
      arm64) yt="yt-dlp_linux_aarch64" ;; \
      *)     yt="yt-dlp" ;; \
    esac \
 && curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/${yt}" -o /usr/local/bin/yt-dlp \
 && chmod +x /usr/local/bin/yt-dlp \
 && apt-get purge -y curl && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . /app

# install server dependencies + build the web client into client/dist so the
# first start is fast (the entrypoint rebuilds only when an update lands).
RUN npm install --omit=dev \
 && npm run build \
 && npm cache clean --force \
 && chmod +x docker/entrypoint.sh

ENV NODE_ENV=production \
    NEBULA_PORT=80 \
    NEBULA_DATA=/data \
    AUTO_UPDATE=true

EXPOSE 80
VOLUME ["/data"]

# the app is healthy once /api/status answers
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.NEBULA_PORT||80)+'/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini","--","/app/docker/entrypoint.sh"]
