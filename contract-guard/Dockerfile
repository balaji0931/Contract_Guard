# syntax=docker/dockerfile:1
#
# Contract Guard image: compiles the React + Vite + Tailwind dashboard and the
# TypeScript backend, then ships a production runtime containing only
# production dependencies and build output.
#
# The image itself is useless without the kit: `specs/` and `consumers/` are
# mounted read-only at /kit (see docker-compose.yml), never baked in.

# ---- stage 1: dashboard build (tsc --noEmit && vite build) -------------------
FROM node:24-bookworm AS client
WORKDIR /build/client
COPY client/package.json client/package-lock.json ./
RUN npm ci --no-fund --no-audit
COPY client/ ./
RUN npm run build

# ---- stage 2: backend compile (tsc -p tsconfig.json) --------------------------
FROM node:24-bookworm AS backend
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --no-fund --no-audit
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- stage 3: runtime ----------------------------------------------------------
FROM node:24-bookworm AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit
COPY --from=backend /build/dist ./dist
COPY --from=client /build/client/dist ./client/dist
# Data dir holds the SQLite file (mount a volume here to keep audit history
# across container rebuilds); the app must be able to write it.
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 5051
CMD ["node", "dist/server.js"]
