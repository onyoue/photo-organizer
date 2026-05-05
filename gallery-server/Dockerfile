# Cullback gallery server — single-stage Bun image.
# Image size ~150 MB; the data dir is mounted from the host as a volume so
# upgrades just rebuild the image without touching photos.
FROM oven/bun:1-alpine

WORKDIR /app

# Dependencies stay tiny (just types). Copy package descriptors first so
# Docker can cache the install layer across source-only rebuilds.
COPY package.json ./
RUN bun install --production --frozen-lockfile || bun install --production

COPY src ./src
COPY tsconfig.json ./

ENV NODE_ENV=production \
    PORT=8787 \
    DATA_DIR=/data

EXPOSE 8787
VOLUME ["/data"]

# ADMIN_TOKEN must be passed at runtime — never bake into the image.
CMD ["bun", "run", "src/index.ts"]
