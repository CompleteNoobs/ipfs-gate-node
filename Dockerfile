# ipfs-gate v0.1 — Dockerfile
FROM node:20-alpine

# better-sqlite3 needs build tools for native bindings
RUN apk add --no-cache python3 make g++ curl

WORKDIR /app

# Install deps first (cached layer when only source changes)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# App sources
COPY server.js quota.js hive-verify.js envelope.js moderation.js sweeper.js ./
COPY backends ./backends
COPY migrations ./migrations

# Data dir (mounted as volume in compose)
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3001
CMD ["node", "server.js"]