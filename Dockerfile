# ============================================================================
# Mahyar Gap — Multi-Stage Production Dockerfile for Railway Deployment
# ----------------------------------------------------------------------------
# IMPORTANT — WHY NOT ALPINE:
# The Mahyar Music worker loads @livekit/rtc-node, whose native FFI bindings
# (@livekit/rtc-ffi-bindings-linux-x64-gnu / -arm64-gnu) ship ONLY as GNU/glibc
# binaries and declare `libc: [glibc]` in their package metadata. On Alpine
# (musl) npm silently skips the native binding, `require('@livekit/rtc-node')`
# throws, and the worker dies with "exited during startup (code 1)".
# Both stages therefore use the glibc Debian base node:22-bookworm-slim.
# LiveKit's own Docker guidance recommends exactly this. DO NOT switch back
# to Alpine or add musl-compat shims.
# ============================================================================

# ---------------------------------------------------------------- builder ---
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Build-time system packages only (none of these are copied to the runner):
#  - openssl          : Prisma engines on Debian bookworm (OpenSSL 3.x)
#  - ca-certificates  : TLS for npm registry + Prisma engine downloads
#  - python3/make/g++ : fallback toolchain for native addons without a
#                       prebuilt glibc binary (e.g. bcrypt source builds)
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY prisma ./prisma/

RUN npm ci
RUN npx prisma generate

# Early gate: fail the build HERE if the glibc native binding for this
# architecture was not installed (e.g. someone switches the base image back
# to musl). npm omits it silently — catch it before the expensive build.
RUN node -e "const p=process.arch==='arm64'?'@livekit/rtc-ffi-bindings-linux-arm64-gnu':'@livekit/rtc-ffi-bindings-linux-x64-gnu'; try { require.resolve(p); } catch { console.error('FATAL: '+p+' is missing from node_modules.'); console.error('The base image must be a GNU/glibc distribution (node:22-bookworm-slim), not Alpine/musl.'); process.exit(1); } console.log('[builder] LiveKit native binding present: '+p);"

COPY . .
RUN npm run build

# ----------------------------------------------------------------- runner ---
# Same Debian/glibc family as the builder so the native modules installed
# there keep working in the production image.
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# Runtime packages:
#  - ffmpeg           : required by the Mahyar Music worker (decodes audio to
#                       PCM s16le frames for the LiveKit AudioSource)
#  - ca-certificates  : TLS for LiveKit wss:// and Railway bucket endpoints
#  - openssl          : Prisma Client runtime
#  - libstdc++6       : C++ runtime required by the rtc-node FFI binding
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates openssl libstdc++6 \
 && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/scripts/verify_runtime.js ./scripts/verify_runtime.js
COPY --from=builder /app/index.html ./index.html
COPY --from=builder /app/favicon.ico ./favicon.ico
COPY --from=builder /app/favicon.svg ./favicon.svg
COPY --from=builder /app/css ./css
COPY --from=builder /app/js ./js
COPY --from=builder /app/public ./public

# Hard gate (FIX 2): verify the native runtime INSIDE this image before it can
# ship. Fails the Docker build with a meaningful error instead of deploying a
# broken Music Worker:
#   - Linux + supported architecture + glibc (not musl)
#   - the GNU native binding exists and every shared library resolves (ldd)
#   - require('@livekit/rtc-node') loads and a Room can be constructed
#   - ffmpeg runs
#   - dist/server/music/worker-main.js exists and parses (entrypoint check)
RUN node scripts/verify_runtime.js

# Railway injects dynamic $PORT at runtime
EXPOSE 3000

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server/index.js"]
