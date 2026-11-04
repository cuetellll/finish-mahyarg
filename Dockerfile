# Mahyar Gap — lightweight Railway production image
# Debian slim is used for predictable native dependencies (Prisma / bcrypt).
# The shared music player runs in browsers; no server-side LiveKit audio worker exists.

FROM node:22-bookworm-slim AS builder
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci
RUN npx prisma generate
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
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
RUN node scripts/verify_runtime.js
EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server/index.js"]
