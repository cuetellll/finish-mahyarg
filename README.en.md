# 🌌 Mahyar Gap

[🇮🇷 فارسی](README.md) · 🇬🇧 **English**

> **Your friends, your space, your shared music.**

Mahyar Gap is a private communication space for small groups: real-time messaging, LiveKit voice and video, screen sharing, and synchronized music playback for everyone in a voice room.

> **Music architecture:** Music is played by one HTML Audio element in each member's browser. Socket.IO synchronizes the queue and playback timeline. Music is not published as a LiveKit audio participant. Human voice and video continue to use LiveKit.

---

## ✨ Core Features

| Feature | Description |
| --- | --- |
| 💬 Messaging | Text channels, DMs, replies, reactions, pins, and typing indicators |
| 🎙️ Voice | LiveKit voice rooms, microphone controls, and deafen |
| 🎥 Video & Screen Share | Responsive camera and screen-sharing layouts |
| 🎵 Mahyar Music | Synchronized playback of shared-library files in each voice member's browser |
| 🗂️ Shared Music Library | Upload authorized audio, search, shared queue, and playlists |
| 🔊 Personal Audio Controls | Per-device music volume and mute |
| 🌐 Bilingual | Persian (`/fa`) and English (`/en`) public pages |
| 🪶 Lightweight | No music worker, no server-side PCM playback pipeline, no additional Redis or microservices |

## 🧭 How Shared Music Works

1. Members join a Voice Channel.
2. An authorized audio file is uploaded to that server's Music Library.
3. A member types `/mp play Believer` in the chat.
4. The server synchronizes the queue and playback timeline through Socket.IO.
5. Each member's browser plays the same private file directly from the Railway Bucket using a short-lived signed URL.
6. Play, Pause, Resume, Skip, and Stop are shared. Volume and Mute are local to each listener.

**Browser note:** Each member may need to click **Enable Audio** once because browsers can block autoplay until a user gesture.

## ⌨️ Music Commands

```text
/mp play <track name>
/mp queue
/mp pause
/mp resume
/mp skip
/mp stop
/mp nowplaying
```

Volume and Mute are not slash commands. Right-click the **Mahyar Music** player row/panel to adjust your own output.

## 🏗️ Architecture Overview

```text
Browser A ── signed media URL ──┐
Browser B ── signed media URL ──┼── Railway Storage Bucket (private audio)
Browser C ── signed media URL ──┘

Mahyar Gap / Express ── PostgreSQL (users, library metadata, playlists)
          │
          └── Socket.IO (shared queue + playback timeline)

Human Voice / Video ── LiveKit
Music Playback ─────── HTMLAudioElement in each browser
```

- Audio files are not stored in PostgreSQL; only metadata and object keys are.
- Normally, each browser reads audio directly from the Bucket.
- If Bucket CORS blocks browser PUT, the app automatically falls back to a same-origin streaming upload endpoint. This uses Railway application-service egress.
- Queue and playback state are currently kept in server memory. A server restart clears the active queue and playback session.

## 🧰 Technology Stack

| Layer | Technology |
| --- | --- |
| Runtime | Node.js 22.22+ |
| Backend | Express + TypeScript |
| Realtime | Socket.IO |
| Voice / Video | LiveKit (`livekit-server-sdk`, `livekit-client`) |
| Database | PostgreSQL + Prisma |
| Object Storage | Railway Storage Bucket (S3-compatible) |
| Audio validation | FFmpeg / FFprobe for upload validation and artwork only, not playback |
| Frontend | HTML, JavaScript, CSS, Tailwind build |

## ✅ Prerequisites

- Node.js 22.22 or newer
- PostgreSQL
- A LiveKit project for human voice/video
- A Railway project and private Railway Storage Bucket (suggested display name: `mahyar-music`)
- FFmpeg and FFprobe for validating uploaded audio (installed in the Docker image)

## 🚀 Local Development

```bash
# Install dependencies
npm ci

# Create local environment file
cp .env.example .env

# Generate Prisma Client and apply migrations
npm run db:generate
npm run db:migrate

# Start development server
npm run dev
```

Routes:

| Path | Purpose |
| --- | --- |
| `/` | Redirects to Persian landing page |
| `/fa` | Persian landing page |
| `/en` | English landing page |
| `/app` | Main application |

Production build and start:

```bash
npm run build
npm start
```

## 🚂 Deploy on Railway

1. Connect the repository to Railway.
2. Add a Railway PostgreSQL service and reference its `DATABASE_URL` from the web service.
3. Deploy the web service using the included Dockerfile.
4. Configure JWT and LiveKit variables on the web service.
5. Add a **Storage Bucket** to the same Railway project.
6. Connect Bucket credentials to the web service using Railway Variable References.
7. After deployment, open `/app` and test upload and playback.

### ☁️ Create a Railway Storage Bucket

1. Open the Mahyar Gap project in Railway Dashboard.
2. In the intended environment (usually Production), choose **Create → Bucket**.
3. Name it e.g. `mahyar-music` and choose a region near the web service.
4. Create the Bucket and open its **Credentials** tab.
5. Reference the following values from the Bucket in the web service:

| Variable | Value |
| --- | --- |
| `AWS_ENDPOINT_URL` | Endpoint shown in Credentials |
| `AWS_ACCESS_KEY_ID` | Access key |
| `AWS_SECRET_ACCESS_KEY` | Secret key |
| `AWS_S3_BUCKET_NAME` | Actual S3 bucket identifier, not just the display name |
| `AWS_DEFAULT_REGION` | Region shown in Credentials |
| `AWS_S3_URL_STYLE` | Follow Credentials; usually `virtual-hosted` |

**Important:** Keep secrets only in Railway Variables. Never commit them or expose them in browser code, README files, logs, or screenshots. The AWS SDK is used only for the S3-compatible protocol; Railway Bucket remains the only object-storage provider.

### 📤 Music Upload and CORS

- The app first attempts a direct browser upload to the Bucket using a presigned URL.
- If Bucket CORS blocks the browser PUT, the app automatically falls back to a same-origin streaming upload endpoint.
- Therefore Bucket CORS is not required for the basic upload flow; configuring it only enables the direct path and reduces application-service egress.
- The fallback streams the file without buffering the entire file in RAM, but its traffic passes through the Railway application service.

### 🔐 Important Environment Variables

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection |
| `JWT_ACCESS_SECRET` | JWT signing secret |
| `LIVEKIT_URL` | LiveKit server URL |
| `LIVEKIT_API_KEY` | LiveKit API key |
| `LIVEKIT_API_SECRET` | LiveKit API secret |
| `AWS_ENDPOINT_URL` | Railway Bucket endpoint |
| `AWS_ACCESS_KEY_ID` | Bucket access key |
| `AWS_SECRET_ACCESS_KEY` | Bucket secret key |
| `AWS_S3_BUCKET_NAME` | S3 bucket identifier |
| `AWS_DEFAULT_REGION` | Bucket region |
| `AWS_S3_URL_STYLE` | Bucket URL addressing style |
| `MUSIC_MAX_FILE_MB` | Per-file size limit; default 25 MB |
| `MUSIC_SERVER_QUOTA_MB` | Per-server quota; default 500 MB |
| `MUSIC_MAX_DURATION_SEC` | Maximum track length; default 1800 seconds |
| `MUSIC_MAX_TRACKS` | Maximum tracks per server |
| `MUSIC_MAX_QUEUE` | Maximum queue size |

See `.env.example` for the complete list. Use actual secrets from Railway Credentials.

## 🧪 Tests and Verification

```bash
npm run lint
npm run build
npm test
```

For real playback verification in the deployed environment:

1. Upload a small authorized MP3.
2. Confirm that the track appears in the Music Library.
3. Join the same Voice Channel from two independent browsers.
4. Run `/mp play <track>` in one browser.
5. Click **Enable Audio** in each browser if required.
6. Test Pause/Resume/Skip and each listener's personal volume.

A successful build or a visible Playing badge alone does not prove real playback.

## 🛠️ Troubleshooting

| Problem | What to check |
| --- | --- |
| Upload fails | Bucket variables, credentials, file size, quota, and web-service logs |
| CORS error | Same-origin streaming fallback should activate; if it does not, inspect Network and server logs |
| Track not found | Confirm the file is in the same server's library and has not been deleted |
| One member hears nothing | Click Enable Audio on that device; check local mute and browser volume |
| Playback drifts | Check Socket.IO connectivity, network latency, and device load; zero-millisecond sync is not guaranteed |
| Voice unavailable | Check LiveKit variables, browser microphone permissions, and logs |
| Queue disappears after restart | The current queue is in-memory and is not persistent in this version |

## 🔒 Security and Limitations

- The Bucket is private; file access uses authenticated endpoints and short-lived signed URLs.
- Upload only audio you own or are authorized to share with your private group.
- Never publish tokens, secrets, or presigned URLs in issues or public screenshots.
- Railway Free limits depend on current credits, storage, egress, CPU, and RAM; they are not unlimited. Check the current Railway dashboard and official pricing documentation.
- Browser playback depends on format support in the visitor's browser and operating system. MP3 is the recommended primary format.

---

<p align="center"><strong>MAHYAR GAP</strong><br/>Your Friends. Your Space. Your Music. 💜</p>
