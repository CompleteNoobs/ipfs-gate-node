# ipfs-gate v0.1 — Dockerfile
FROM node:20-alpine

# better-sqlite3 needs build tools for native bindings
RUN apk add --no-cache python3 make g++ curl

WORKDIR /app

# Install deps first (cached layer when only source changes)
COPY package.json ./

# escrow-core is a sibling dependency (`file:../escrow-core` in package.json) and
# lives OUTSIDE this build context. `npm run docker:prep` vendors a clean source
# snapshot into ./vendor/escrow-core; we place it at /escrow-core — a sibling of
# /app — so the UNCHANGED `file:../escrow-core` path resolves at install time
# exactly as on bare metal. --install-links packs it as a real directory (a
# symlink would resolve escrow-core's own deps from /escrow-core, which has no
# node_modules in the image → boot crash). Replaces the old `npm ci`: the file:
# dep makes the lockfile machine-local.
COPY vendor/escrow-core /escrow-core
RUN npm install --omit=dev --install-links

# App sources.
# Use a glob, NOT a hardcoded file list: an explicit list silently dropped
# pricing.js (Stage 1a) + release-policy.js (Stage 3) from the image, so the new
# server.js crash-looped on `Cannot find module './pricing'` → nginx 502. Globbing
# every top-level module means future stages (Stage 6+) ship automatically.
# (test/ is a subdir → not matched by *.js, so tests don't bloat the image.)
# *.mjs covers the box-mode Nostr client (escrow-box-client.mjs).
COPY *.js *.mjs ./
COPY backends ./backends
COPY migrations ./migrations

# Data dir (mounted as volume in compose)
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3001
CMD ["node", "server.js"]