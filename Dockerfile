# Stage 1: Build Frontend
FROM node:20-slim AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# Stage 2: Backend & Final Image
FROM node:20-slim
WORKDIR /app

# WhatsApp now goes through Evolution API over HTTP, so there is no browser in
# this image. The ~40 lines of Chromium + X11/GTK/font packages that used to
# live here existed solely for whatsapp-web.js/Puppeteer.
# curl is kept for container healthchecks.
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm install --omit=dev

COPY backend/ ./
# Copy built frontend from Stage 1 (Vite is configured to output to ../backend/public)
COPY --from=frontend-builder /app/backend/public ./public

EXPOSE 3000

# Redirects data/ and uploads/ onto a mounted volume when one is present
# (Railway); a no-op elsewhere.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

CMD ["/usr/local/bin/docker-entrypoint.sh"]
