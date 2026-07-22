# ipfs-gate v0.1 — Dockerfile
FROM node:20-alpine

# better-sqlite3 needs build tools for native bindings
RUN apk add --no-cache python3 make g++ curl

WORKDIR /app

# Install deps first (cached layer when only source changes)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# App sources.
# Use a glob, NOT a hardcoded file list: an explicit list silently dropped
# pricing.js (Stage 1a) + release-policy.js (Stage 3) from the image, so the new
# server.js crash-looped on `Cannot find module './pricing'` → nginx 502. Globbing
# every top-level module means future stages (Stage 6+) ship automatically.
# (test/ is a subdir → not matched by *.js, so tests don't bloat the image.)
COPY *.js ./
COPY backends ./backends
COPY migrations ./migrations

# Data dir (mounted as volume in compose)
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3001
CMD ["node", "server.js"]