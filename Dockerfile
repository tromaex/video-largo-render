FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates fonts-dejavu-core && rm -rf /var/lib/apt/lists/* && curl -sSL -o /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux && chmod +x /usr/local/bin/yt-dlp && yt-dlp --version
RUN mkdir -p /usr/share/fonts/truetype/anton && (curl -sSL --fail -o /usr/share/fonts/truetype/anton/Anton-Regular.ttf https://github.com/google/fonts/raw/main/ofl/anton/Anton-Regular.ttf || true)
WORKDIR /app
COPY server.js library.json ./
RUN mkdir -p /data/lib && node --check server.js
ENV PORT=8080 DATA=/data
EXPOSE 8080
CMD ["node","server.js"]
