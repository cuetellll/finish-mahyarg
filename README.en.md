# Mahyar Gap

[🇮🇷 فارسی](README.md) | 🇬🇧 **English**

> **Your Friends. Your Space. Your Music.**

Mahyar Gap is a light, private communication space for a small group of friends: text channels, direct messages, real LiveKit voice rooms, video calls, screen sharing, and a genuine music bot called **Mahyar Music** that plays tracks from the server's shared library.

It is built for roughly **five people** running on the **Railway Free** plan. The only object-storage provider in this project is a **Railway Storage Bucket**.

---

## ✨ Features

| Feature | Description |
| --- | --- |
| 💬 **Real-time messaging** | Text channels, direct and group messages, replies, reactions, pins, threads and search over Socket.IO |
| 🎙️ **Real voice rooms** | Live audio on LiveKit with speaking indicators, microphone, deafen and connection quality |
| 🎥 **Video & screen sharing** | Camera and screen publishing with a dedicated screen-share layout and fullscreen |
| 🎵 **Mahyar Music** | A real LiveKit bot participant named `Mahyar Music`, with a shared queue and per-listener volume |
| 🗂️ **Shared music library** | Direct uploads to the bucket, metadata extraction, search and playlists |
| 🔐 **Secure accounts** | bcrypt, JWT access tokens, server-side RBAC and role management |
| 👥 **Private space** | Servers, private channels, invite links, kick and ban |
| 🌐 **Bilingual** | Persian (default) and English landing pages with complete RTL/LTR layouts |
| 🪶 **Lightweight** | No Redis, no microservices, no extra paid services |

---

## 🖼️ Screenshots

Capture these from your own running deployment and place them under `docs/screenshots/`:

| File | What it shows |
| --- | --- |
| `docs/screenshots/landing-fa.png` | Persian landing page: ambient background, floating icons, app preview |
| `docs/screenshots/voice-room.png` | Compact voice room with participant tiles and the control dock |
| `docs/screenshots/music-library.png` | Shared music library and the player panel |

> This repository ships no mocked-up imagery; screenshots must come from the real build.

---

## 🧱 Technology stack

| Layer | Technology |
| --- | --- |
| Runtime | Node.js 22 + TypeScript |
| Web server | Express 4 |
| Realtime | Socket.IO 4 |
| Live audio | LiveKit (`livekit-server-sdk` + `@livekit/rtc-node`) |
| Database | PostgreSQL + Prisma 5 |
| Storage | **Railway Storage Bucket** (S3-compatible) |
| Auth | JWT + bcrypt |
| Frontend | Plain HTML + JavaScript, locally built Tailwind, Font Awesome |
| Audio processing | FFmpeg (installed in the Dockerfile) |

---

## 🏗️ Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                          User browser                            │
│   Landing (/fa, /en)   •   App (/app)   •   Music library        │
└───────────┬──────────────────────────┬───────────────────────────┘
            │ HTTPS / WebSocket        │ presigned PUT (audio)
            ▼                          ▼
┌───────────────────────────┐   ┌──────────────────────────────────┐
│  Express + Socket.IO      │   │  Railway Storage Bucket          │
│  • REST API               │   │  name: mahyar-music (private)    │
│  • auth + RBAC            │   │  • shared music                  │
│  • LiveKit token issuing  │   │  • file attachments              │
│  • presigned URL issuing  │   └──────────────┬───────────────────┘
└───────────┬───────────────┘                  │ presigned GET
            │ Prisma                           │
            ▼                                  ▼
    ┌───────────────┐              ┌────────────────────────┐
    │  PostgreSQL   │              │  Music Worker          │
    │  (Railway)    │              │  node worker-main.js   │
    └───────────────┘              │  FFmpeg → PCM          │
                                   └───────────┬────────────┘
                                               │ audio frames
                                               ▼
                                   ┌────────────────────────┐
                                   │   LiveKit Room         │
                                   │   Mahyar Music (bot)   │
                                   └────────────────────────┘
```

**Design notes**

- Audio goes from the browser **straight** to the bucket (`presigned PUT`); the file body never travels through Express memory.
- Each active voice room has at most **one** short-lived music worker that exits when the room empties or playback stops.
- Playback position lives in memory and is not persisted per second.

---

## ✅ Requirements

- Node.js **22** or newer
- PostgreSQL 14+
- A **LiveKit** project (Cloud or self-hosted)
- A **Railway Storage Bucket** named `mahyar-music`
- `ffmpeg` on the host (already installed in the Dockerfile)

---

## 🚀 Local setup

```bash
# 1) Install dependencies
npm ci

# 2) Create the environment file
cp .env.example .env
# Fill in real values in .env (never commit it)

# 3) Prisma client + migrations
npx prisma generate
npx prisma migrate deploy

# 4) Run in development
npm run dev
```

The app listens on `http://localhost:3000`:

| Path | Description |
| --- | --- |
| `/` | Redirects to `/fa` |
| `/fa`, `/en` | Public landing pages |
| `/app` | The application |

### Production build

```bash
npm run build     # Tailwind + LiveKit client bundle + tsc
npm start         # node dist/server/index.js
```

---

## 🚂 Railway deployment

1. Connect the repository to Railway. `railway.json` and `Dockerfile` are already configured.
2. Add the Railway **PostgreSQL** service and reference its `DATABASE_URL` from the web service.
3. Set the LiveKit variables on the web service.
4. Set `JWT_ACCESS_SECRET` to a random value of at least 32 characters.
5. On the first deploy, migrations run automatically (`prisma migrate deploy` in the start command).

> ⚠️ Keep the service at **one** replica. Queue state is in process memory; multiple replicas would disagree.

---

## 🪣 Railway Bucket setup (step by step)

This section assumes no backend experience. Follow the order exactly.

1. Open the **Railway Dashboard**.
2. Open your existing **Mahyar Gap** project.
3. Click **New** and choose **Bucket**.
4. Name the bucket `mahyar-music`.
5. Pick a **region** close to your web service (same region means lower latency).
6. Click **Deploy** and wait for the bucket to become ready.
7. Open the bucket and switch to the **Credentials** tab.
8. Connect those values to the **Mahyar Gap** web service. The cleanest way is a **Variable Reference**:
   - Web service → **Variables** → **New Variable** → **Add Reference** → pick the bucket service, then add each value under the **same name** Railway suggests:
     `AWS_ENDPOINT_URL`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_S3_BUCKET_NAME`, `AWS_DEFAULT_REGION`, `AWS_S3_URL_STYLE`.
   - Manual entry works too: create those names on the web service and copy the values from the Credentials tab.
9. Redeploy the service so the new variables are read.
10. Sign in to the app, open a server, press **Library** in the music panel and upload an MP3.
11. In a voice channel run `/mp play <track name>`.
12. Final check: the audio must actually be **heard** in the voice room — not merely displayed in the UI.

### Railway native variable names

| Variable | Purpose |
| --- | --- |
| `AWS_ENDPOINT_URL` | The bucket endpoint URL |
| `AWS_ACCESS_KEY_ID` | The bucket access key |
| `AWS_SECRET_ACCESS_KEY` | The bucket secret key |
| `AWS_S3_BUCKET_NAME` | The S3 **bucket identifier** — not the display name |
| `AWS_DEFAULT_REGION` | The bucket region |
| `AWS_S3_URL_STYLE` | The URL style shown on the Credentials tab |

### Common mistakes

- **Take the bucket identifier from the Credentials tab.** `mahyar-music` in the dashboard is a display name and is not always the S3 bucket identifier. Filling `AWS_S3_BUCKET_NAME` with the display name yields `NoSuchBucket`.
- **Read the URL style from the Credentials tab.** Railway Buckets default to **virtual-hosted** style, which is why the code runs with `forcePathStyle: false`. Only set `AWS_S3_URL_STYLE=path` when the credentials explicitly show path-style.
- **Keep the bucket private.** Nothing is served publicly; downloads use short-lived signed URLs.
- **Keys stay server-side.** No access key is ever sent to browser JavaScript or printed in logs.

### Browser-direct uploads and CORS

Music uploads use `presigned PUT`, so the browser writes to the bucket directly. That keeps application memory and bandwidth low.

Railway exposes no CORS panel or variable — the rules only exist on the S3 API of the bucket itself. Without a matching rule the browser drops the `OPTIONS` preflight, never sends the `PUT`, and all the UI can report is:

```
Upload to storage failed: the browser could not reach the bucket.
```

**Diagnose and fix** with the script in this repository (it reads the same variables the server does):

```bash
# 1) Inspect the current rules and whether the app origin may PUT
npm run bucket:cors -- --check --origin https://<your-app>.up.railway.app

# 2) Write the rule for the app origin (add localhost for development if needed)
npm run bucket:cors -- --apply https://<your-app>.up.railway.app http://localhost:3000
```

On Railway, where there is no `.env` file, run the same script through the CLI:

```bash
railway run node scripts/bucket_cors.js --apply https://<your-app>.up.railway.app
```

The rule it writes: the given origins, methods `PUT, GET, HEAD`, headers `*`, `ETag` exposed, `MaxAgeSeconds=3000`. The app also exposes `GET /api/music/upload/diagnostics`, which reports whether a rule exists and whether the current origin may upload — that answer is what turns the opaque browser failure into a precise error message in the UI.

### When the bucket refuses direct uploads (the fallback is live)

Uploads work before any CORS configuration: if the browser's direct `PUT` to the bucket fails (network/CORS error), the same file is sent, without any user action, to the same-origin endpoint `POST /api/music/upload/stream`, which relays it into the bucket as a multipart upload.

- The body is never buffered whole: one 8 MiB part of the incoming stream is in memory at a time (concurrency 1).
- The size limit is enforced on `Content-Length` and again on the actual bytes; exceeding it aborts the multipart upload so no half-written object is left behind.
- Authentication, server membership and the upload permission still come from `init` (via `upload_token`); content verification (HEAD + magic bytes + ffprobe), duplicate detection and the `MusicTrack` insert still come from `complete` — an interrupted relay creates no catalog row.
- Cost: this path uses **application service egress**, unlike direct uploads. That is why direct uploads stay the preferred path and become active automatically once a CORS rule exists on the bucket.

> **Honest status:** configuring CORS on a real Railway bucket has **not** been verified in this repository (no real credentials were available); the code and script follow the standard `PutBucketCORS` behaviour. The relay path has only been exercised locally against a stub S3 (part sizing, size cap, abort), not against the real Railway bucket.

---

## 🔐 Environment variables

| Variable | Required | Default | Description |
| --- | :---: | --- | --- |
| `NODE_ENV` | ✅ | `production` | Runtime mode |
| `PORT` | ➖ | `3000` | Service port (Railway injects it) |
| `DATABASE_URL` | ✅ | — | PostgreSQL connection string |
| `JWT_ACCESS_SECRET` | ✅ | — | At least 32 characters; enforced in production |
| `BCRYPT_ROUNDS` | ➖ | `12` | Password hashing cost |
| `LIVEKIT_URL` | ✅ | — | `wss://...` |
| `LIVEKIT_API_KEY` | ✅ | — | Server-side only |
| `LIVEKIT_API_SECRET` | ✅ | — | Server-side only |
| `CORS_ORIGIN` | ➖ | — | Exact browser origin when it differs |
| `AWS_ENDPOINT_URL` | ✅ for music/attachments | — | Railway bucket endpoint |
| `AWS_ACCESS_KEY_ID` | ✅ | — | Bucket access key |
| `AWS_SECRET_ACCESS_KEY` | ✅ | — | Bucket secret |
| `AWS_S3_BUCKET_NAME` | ✅ | — | S3 bucket identifier |
| `AWS_DEFAULT_REGION` | ➖ | `auto` | Bucket region |
| `AWS_S3_URL_STYLE` | ➖ | `virtual-hosted` | `virtual-hosted` or `path` |
| `MUSIC_MAX_FILE_MB` | ➖ | `25` | Max size per audio file |
| `MUSIC_SERVER_QUOTA_MB` | ➖ | `500` | Per-server storage quota |
| `MUSIC_MAX_DURATION_SEC` | ➖ | `1800` | Max track duration |
| `MUSIC_MAX_TRACKS` | ➖ | `500` | Max tracks per server library |
| `MUSIC_MAX_QUEUE` | ➖ | `50` | Max queued tracks per room |

When the `AWS_*` variables are missing, music uploads and attachments answer an explicit `501` naming the missing variables. Nothing is simulated.

---

## 🗄️ Database configuration

```bash
npx prisma generate          # build the client
npx prisma migrate deploy    # apply migrations (production)
npx prisma studio            # browse data (optional)
```

Existing migrations under `prisma/migrations` cover the initial schema, channel access, the per-server music toggle and the music library. Add a new migration for schema changes; never edit old migrations.

---

## 🎧 Using the music library

1. Open a server and a voice channel.
2. In the **Mahyar Music** panel press **Library**.
3. Choose or drag & drop an audio file (mp3, m4a, aac, ogg, opus, wav, flac).
4. The server validates size, real content type and duration, then extracts metadata.
5. The track appears in that server's shared library.

Default limits: 25 MB per file, 500 MB per server, 30 minutes per track.

---

## 🎵 Music commands

| Command | Effect |
| --- | --- |
| `/mp play <track name>` | Search the library and play for everyone |
| `/mp queue` | Show the queue |
| `/mp pause` | Pause playback |
| `/mp resume` | Resume playback |
| `/mp skip` | Skip to the next track |
| `/mp stop` | Stop and clear the queue |
| `/mp nowplaying` | Show the current track |

- By default everyone may upload, play, queue and control playback.
- Volume and mute are **personal**: right-click `Mahyar Music` in the voice member list. Your volume never affects other listeners.

---

## 🎥 Using voice and video

- Join by clicking a voice channel or pressing **Join Voice**.
- In a text channel, a compact **Voice Dock** appears above the messages after connecting; it never covers the composer.
- Controls: microphone, deafen, camera, screen share, audio/video settings and leave.
- **Fullscreen**: the button in the voice room header; exit with the same button or `Escape`.
- If the camera fails, the exact cause is shown (permission denied, no camera, camera in use, unsupported constraints…) and your microphone and connection stay intact.

---

## 🔒 Security

- Passwords are hashed with **bcrypt**; plaintext is never stored.
- **JWT** access tokens (7 days) with refresh support (`/auth/refresh`).
- **Server-side RBAC** on every operation; the UI only mirrors it.
- Helmet with a strict CSP; the storage origin is explicitly added to `connect-src`.
- Bucket objects are private; downloads use short-lived signed URLs.
- Bucket and LiveKit keys are read server-side only and never appear in API responses or logs.
- Rate limiting on `/api/` and `/auth/`.

---

## 💳 Free plan limitations

Mahyar Gap is tuned for the Railway Free plan, but "free" is not "unlimited":

| Topic | Reality |
| --- | --- |
| Bucket allowance | Up to **10 GB-month** on the Free plan |
| Storage billing | Based on **actual usage**, charged against the **monthly usage credit** |
| Bucket API operations | No additional usage charge |
| Bucket egress | No additional usage charge |
| Application service egress | **Separate** and billed |
| Music playback in LiveKit | The bot publishing audio uses **application service** resources |
| Credit exhausted | Storage access can be **suspended** |

Practical consequences:

- Storage is not unlimited free storage; keep the quotas sensible for five users (`MUSIC_MAX_FILE_MB`, `MUSIC_SERVER_QUOTA_MB`).
- Free bucket egress does **not** make music playback entirely free: publishing the bot's audio to LiveKit consumes CPU and network on the application service.
- Remove unused tracks so the monthly allowance is not wasted.

Always check Railway's current Pricing page and official documentation for exact, up-to-date numbers; this table summarises Free-plan behaviour at the time of writing.

---

## 🧰 Troubleshooting

<details>
<summary><b>Music upload returns 501</b></summary>

The `AWS_*` variables are incomplete. The API response lists them in `missingVariables`; set them on the web service and redeploy.
</details>

<details>
<summary><b>NoSuchBucket or 403 while uploading</b></summary>

Use the bucket identifier from the Credentials tab (not the display name), then verify the URL style: virtual-hosted is the default, and path-style requires `AWS_S3_URL_STYLE=path`.
</details>

<details>
<summary><b>Browser upload stops with a CORS error</b></summary>

The bucket has no CORS rule for the app origin. Allow the origin, methods `PUT, GET, HEAD`, headers `*`, and expose `ETag`. If your bucket cannot do that, uploads must stream through the server (higher application egress).
</details>

<details>
<summary><b>The bot joins but no audio is heard</b></summary>

A bot connection or a successful command is not proof of playback. Check that `ffmpeg` exists in the image (it is installed in the Dockerfile), the object exists in the bucket, and `Mahyar Music` is not muted locally. Inspect the music worker logs and CPU for a real diagnosis.
</details>

<details>
<summary><b>The camera will not start</b></summary>

The message names the cause: permission denied, no camera, camera already in use, or unsupported constraints. Pick the right camera in Audio & Video settings. A camera error never disconnects your microphone or the room.
</details>

<details>
<summary><b>Fullscreen does nothing</b></summary>

The fullscreen control exists in the voice room header. Exit with the same button or `Escape`. If the browser blocks it, a clear message is shown (this happens inside iframes or kiosk mode).
</details>

<details>
<summary><b>The landing page is missing</b></summary>

`/fa` and `/en` are served from `public/landing`. Confirm `public/landing/fa.html` and `en.html` are copied into the image (the Dockerfile copies the whole `public` folder).
</details>

---

## ⚠️ Known limitations

- Designed for **one replica**; queue state is in process memory.
- The only playback source is the server's shared library. Spotify, SoundCloud and YouTube are intentionally unsupported.
- Direct-upload CORS behaviour on a **real Railway Bucket** is not verified with this repository's credentials; configure CORS if the browser refuses uploads.
- Server-side validation writes the audio to a temporary file for `ffprobe` (bounded and cleaned up), even though the upload itself never passes through application memory.
- Each concurrently active voice room runs its own music worker; keep active rooms low on the Free plan.
- The application UI is English; the landing pages are Persian and English.

---

## 📄 Ownership

This is a private project for a small group of friends. Uploaded audio must be owned by or licensed to that group.

---

Built for friends — **Your Friends. Your Space. Your Music.**
