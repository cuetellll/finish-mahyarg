/**
 * Mahyar Music — dedicated worker process entrypoint.
 *
 * Each active music room gets its own short-lived Node process that owns the
 * @livekit/rtc-node room connection, the audio source and the ffmpeg decoder.
 * Rationale: the native RTC runtime must never be able to wedge the main HTTP
 * server, and a crashed/finished worker releases EVERY resource (LiveKit
 * connection, audio track, ffmpeg) simply by exiting.
 *
 * Startup is a sequence of NAMED STEPS (process-init → native-module-load →
 * ffmpeg-discovery → token-create → room-connect → audio-source-create →
 * track-publish → ready). Every step emits a `startup-log` message to the
 * parent and a line on stdout, so a Railway Deploy Log shows exactly where a
 * broken deployment died (e.g. the glibc native binding failing to load).
 *
 * NOTE: @livekit/rtc-node and @livekit/rtc-ffi-bindings are loaded DYNAMICALLY
 * inside step 2 on purpose. A static import would crash the process at
 * require-time — before any handler could run — and the parent would only see
 * "exited during startup (code 1)" with zero diagnostics.
 *
 * Protocol (JSON lines over IPC via process.send/on('message')):
 *   parent → worker : { type: 'play', url, offset }
 *                     { type: 'stop-playback' }
 *                     { type: 'shutdown' }
 *   worker → parent : { type: 'startup-log', step, status, detail? }  (per startup step)
 *                     { type: 'ready' }                       (room joined, track published)
 *                     { type: 'playing' }                     (decoder producing audio)
 *                     { type: 'duration', seconds }
 *                     { type: 'track-ended' }
 *                     { type: 'fatal-error', message }
 *                     { type: 'disconnected', reason }
 *                     { type: 'participants', count }         (periodic + on change)
 *                     { type: 'fatal', message, step? }       (worker cannot continue)
 */
import { spawn, execFile, ChildProcess } from 'child_process';
import { access, constants } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { AccessToken } from 'livekit-server-sdk'; // pure JS — safe as a static import
import type { Room, LocalAudioTrack, AudioSource, AudioFrame, TrackPublishOptions as RtcTrackPublishOptions } from '@livekit/rtc-node';
import { libcFlavor, sanitizeText, urlHost } from './diagnostics';

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const SAMPLES_PER_FRAME = (SAMPLE_RATE / 1000) * 20; // 20 ms frames
const BYTES_PER_FRAME = SAMPLES_PER_FRAME * CHANNELS * 2; // s16le interleaved
const PARTICIPANT_REPORT_MS = 5_000;

/** Runtime handles for the native modules — populated by the load step. */
let rtc: typeof import('@livekit/rtc-node') | null = null;
let ffi: typeof import('@livekit/rtc-ffi-bindings') | null = null;
/** Compile-time view of TrackPublishOptions; the class comes from `ffi` at runtime. */
type TrackPublishOptionsCtor = new (options: Partial<RtcTrackPublishOptions>) => RtcTrackPublishOptions;

let lastParticipantCount = -1;
let resolvedFfmpegPath: string | null = null;

function send(message: Record<string, unknown>) {
  try { if (process.send) process.send(message); } catch { /* parent gone */ }
}

/** Send over IPC and wait (bounded) until the message is flushed to the parent. */
function sendFlushed(message: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    try {
      if (!process.send) return resolve();
      // process.send callbacks when the message is written to the IPC channel.
      const ok = process.send(message, undefined, {}, (error: Error | null) => resolve());
      if (ok === false) resolve(); // channel closed
    } catch { resolve(); }
    setTimeout(resolve, 500).unref?.(); // never hang shutdown on IPC
  });
}

/** Write to stdout/stderr and wait until flushed — pipes buffer asynchronously. */
function writeFlushed(stream: NodeJS.WriteStream, data: string): Promise<void> {
  return new Promise((resolve) => {
    try { stream.write(data, () => resolve()); } catch { resolve(); }
    setTimeout(resolve, 250).unref?.(); // never hang on a dead pipe
  });
}

/**
 * Exit WITHOUT losing diagnostics: flush the IPC fatal message, flush both
 * stdio streams, then exit. A `process.exit()` right after console.log can
 * drop buffered output — the exact failure that hides root causes.
 */
async function flushAndExit(code: number, lines: string[]): Promise<never> {
  for (const line of lines) console.error(sanitizeText(line));
  await sendFlushed({ type: 'fatal', message: sanitizeText(lines.join(' | ')) });
  await writeFlushed(process.stderr, '');
  await writeFlushed(process.stdout, '');
  await new Promise((resolve) => setTimeout(resolve, 150).unref?.());
  process.exit(code);
}

function debugLog(message: string) {
  if (process.env.MUSIC_DEBUG) send({ type: 'decode-debug', message: sanitizeText(message) });
}

// ---------------------------------------------------------------------------
// Startup step machinery
// ---------------------------------------------------------------------------

interface StartupStep { step: string; status: 'start' | 'ok' | 'failed'; detail?: string; at: number }
const startupSteps: StartupStep[] = [];

function logStep(step: string, status: StartupStep['status'], detail?: string) {
  const safeDetail = detail ? sanitizeText(detail) : undefined;
  const record: StartupStep = { step, status, ...(safeDetail ? { detail: safeDetail } : {}), at: Date.now() };
  startupSteps.push(record);
  const line = `[MahyarMusic:worker] step=${step} status=${status}${safeDetail ? ` detail=${safeDetail}` : ''}`;
  if (status === 'failed') console.error(line); else console.log(line);
  send({ type: 'startup-log', step, status, ...(safeDetail ? { detail: safeDetail } : {}) });
}

async function runStep<T>(name: string, fn: () => Promise<T> | T, okDetail?: (result: T) => string | undefined): Promise<T> {
  logStep(name, 'start');
  try {
    const result = await fn();
    logStep(name, 'ok', okDetail?.(result));
    return result;
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    logStep(name, 'failed', message);
    (error as Error & { startupStep?: string }).startupStep = name;
    throw error;
  }
}

async function resolveFfmpeg(): Promise<string | null> {
  const exists = async (bin: string) => { try { await access(bin, constants.X_OK); return true; } catch { return false; } };
  for (const candidate of ['ffmpeg', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
    if (await exists(candidate)) return candidate;
  }
  try {
    const moduleSpec = 'ffmpeg-static';
    const mod = (await import(moduleSpec).catch(() => null)) as { default?: string } | null;
    if (mod?.default && await exists(mod.default)) return mod.default;
  } catch { /* optional */ }
  return null;
}

function ffmpegVersion(bin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, ['-version'], { timeout: 5_000 }, (error, stdout) => {
      if (error) return reject(new Error(`ffmpeg found at ${bin} but failed to execute: ${error.message}`));
      resolve(String(stdout).split('\n')[0]?.trim() || 'ffmpeg (no version output)');
    });
  });
}

/** Best-effort package version by walking up from the resolved entrypoint to
 *  the package root (handles scoped names). Never throws. */
function packageVersion(packageName: string): string {
  try {
    let dir = path.dirname(require.resolve(packageName));
    for (let i = 0; i < 8; i++) {
      const pkgJson = path.join(dir, 'package.json');
      if (existsSync(pkgJson)) {
        const data = JSON.parse(readFileSync(pkgJson, 'utf8'));
        if (data.name === packageName) return String(data.version ?? 'unknown');
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    return 'unknown';
  }
  return 'unknown';
}

let room: Room | null = null;
let audioSource: AudioSource | null = null;
let ffmpeg: ChildProcess | null = null;
let shuttingDown = false;
/** Monotonic decode epoch: every startPlayback bumps it; stale async events from a
 *  killed ffmpeg must never be attributed to the newer track. */
let decodeEpoch = 0;
/**
 * rtc-node allows exactly ONE pending captureFrame per AudioSource. When a track is
 * killed mid-frame, its pump can still be awaiting captureFrame; if the next track's
 * pump calls captureFrame concurrently the source throws "InvalidState" and the whole
 * playback dies. Every pump therefore queues its captures: a stale pump's pending
 * capture settles first, and only then does the live pump push its frame.
 */
let captureChain: Promise<unknown> = Promise.resolve();

function captureFrameQueued(source: AudioSource, frame: AudioFrame, epoch: number): Promise<void> {
  const result = captureChain.then(() => {
    if (epoch !== decodeEpoch) return; // stale pump — drop the frame silently
    return source.captureFrame(frame);
  });
  captureChain = result.catch(() => undefined);
  return result;
}

function stopPlayback() {
  decodeEpoch += 1;
  const child = ffmpeg;
  ffmpeg = null;
  if (child) { try { child.kill('SIGKILL'); } catch { /* already dead */ } }
}

async function startPlayback(url: string, offsetSeconds: number) {
  if (!rtc) { send({ type: 'fatal-error', message: 'Worker native runtime is not loaded.' }); return; }
  if (!room || room.connectionState !== rtc.ConnectionState.CONN_CONNECTED) {
    send({ type: 'fatal-error', message: 'Worker is not connected to the voice room.' });
    return;
  }
  stopPlayback();
  const epoch = decodeEpoch; // this track's own epoch

  const bin = resolvedFfmpegPath || await resolveFfmpeg();
  if (!bin) {
    send({ type: 'fatal-error', message: 'ffmpeg is not available on the server (required for audio decoding).' });
    return;
  }
  resolvedFfmpegPath = bin;
  const seek = offsetSeconds > 0 ? ['-ss', String(Math.floor(offsetSeconds))] : [];
  const args = ['-hide_banner', '-nostats', '-loglevel', 'info', ...seek, '-i', url, '-vn', '-map', '0:a:0', '-ac', String(CHANNELS), '-ar', String(SAMPLE_RATE), '-f', 's16le', 'pipe:1'];
  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  ffmpeg = child;

  let stderrHead = '';
  child.stderr.on('data', (chunk: Buffer) => {
    if (epoch !== decodeEpoch) return;
    stderrHead = (stderrHead + chunk.toString()).slice(-2_000);
    if (stderrHead.length > 8_000) return;
    const match = stderrHead.match(/Duration:\s*(\d+):(\d{2}):(\d{2})\.(\d{2})/);
    if (match) {
      const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 100;
      if (seconds > 0) send({ type: 'duration', seconds });
    }
  });
  child.on('error', (error) => {
    if (epoch !== decodeEpoch || shuttingDown) return;
    send({ type: 'fatal-error', message: `Audio decoder failed: ${sanitizeText(error.message)}` });
  });
  child.on('close', (code) => {
    if (ffmpeg === child) ffmpeg = null;
    debugLog(`ffmpeg close epoch=${epoch} current=${decodeEpoch} code=${code}`);
    // A killed predecessor must never be reported as the current track's failure.
    if (epoch !== decodeEpoch || shuttingDown) return;
    if (code === 0) { send({ type: 'track-ended' }); return; }
    // Surface the decoder's own error lines so failures are diagnosable in the UI.
    const stderrTail = stderrHead.split('\n').map((line) => line.trim()).filter((line) => line.length > 0).slice(-2).join(' | ');
    send({ type: 'fatal-error', message: `Audio decoder exited unexpectedly (code ${code}).${stderrTail ? ` Decoder said: ${sanitizeText(stderrTail)}` : ''}` });
  });

  const source = audioSource!;
  let buffer = Buffer.alloc(0);
  const pump = async (): Promise<void> => {
    try {
      for await (const chunk of child.stdout) {
        if (epoch !== decodeEpoch) return;
        buffer = Buffer.concat([buffer, chunk as Buffer]);
        while (buffer.length >= BYTES_PER_FRAME) {
          const frameBytes = buffer.subarray(0, BYTES_PER_FRAME);
          buffer = buffer.subarray(BYTES_PER_FRAME);
          const samples = new Int16Array(frameBytes.buffer, frameBytes.byteOffset, frameBytes.length / 2);
          await captureFrameQueued(source, new rtc!.AudioFrame(samples, SAMPLE_RATE, CHANNELS, SAMPLES_PER_FRAME), epoch);
        }
      }
    } catch (error) {
      // A real failure on the LIVE pump kills the decoder and reports honestly
      // (the engine advances the queue; the UI shows the error state).
      if (epoch !== decodeEpoch || shuttingDown) return;
      debugLog(`pump error epoch=${epoch}: ${error instanceof Error ? error.message : error}`);
      stopPlayback(); // kills ffmpeg and bumps the epoch so the close handler stays silent
      send({ type: 'fatal-error', message: `Audio pipeline error: ${error instanceof Error ? sanitizeText(error.message) : 'unknown failure'}` });
    }
  };
  void pump();
  debugLog(`ffmpeg spawned epoch=${epoch} url=${url.slice(0, 60)}...`);
  send({ type: 'playing' });
}

function reportParticipants() {
  if (!room || shuttingDown) return;
  const count = room.remoteParticipants.size;
  if (count !== lastParticipantCount) {
    lastParticipantCount = count;
    send({ type: 'participants', count });
  } else {
    send({ type: 'participants', count });
  }
}

// ---------------------------------------------------------------------------
// Startup sequence
// ---------------------------------------------------------------------------

async function main() {
  // Step 1 — process initialization. This MUST come before anything that can
  // fail, so even a hard native crash shows which environment it died in.
  logStep('process-init', 'start');
  const init = JSON.parse(process.env.MUSIC_WORKER_INIT || '{}');
  const { url, apiKey, apiSecret, roomId, identity } = init as { url?: string; apiKey?: string; apiSecret?: string; roomId?: string; identity?: string };
  if (!url || !apiKey || !apiSecret || !roomId) {
    const missing = [!url && 'url', !apiKey && 'apiKey', !apiSecret && 'apiSecret', !roomId && 'roomId'].filter(Boolean).join(', ');
    throw Object.assign(new Error(`Worker initialization is incomplete (missing: ${missing}). Parent must pass MUSIC_WORKER_INIT.`), { startupStep: 'process-init' });
  }
  logStep('process-init', 'ok', `pid=${process.pid} node=${process.version} platform=${process.platform} arch=${process.arch} libc=${libcFlavor()} room=${roomId} identity=${identity}`);

  // Step 2 — native LiveKit runtime. Dynamic import: a static import of a
  // broken native module would terminate the process before this file could
  // report anything. This is the step that catches the Alpine/musl mistake.
  await runStep('native-module-load', async () => {
    try {
      rtc = await import('@livekit/rtc-node');
      ffi = await import('@livekit/rtc-ffi-bindings');
    } catch (error) {
      const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      // Produce an actionable hint for the two classic causes.
      let hint = '';
      if (/ERR_DLOPEN_FAILED|libstdc\+\+|libgcc|GLIBC|version `.*' not found/i.test(raw)) {
        hint = ' A shared library required by the native binding is missing — the production image must be a glibc Debian base with libstdc++6 (see Dockerfile).';
      } else if (/Cannot find module '@livekit\/rtc-ffi-bindings(-linux-[a-z0-9-]+-gnu)?'/.test(raw)) {
        hint = ' The platform-specific native binding package was not installed — npm skips it on musl/Alpine or unsupported architectures. Build the image from node:22-bookworm-slim (glibc).';
      }
      throw new Error(`@livekit/rtc-node native runtime failed to load: ${raw}.${hint}`);
    }
    if (!rtc || !ffi) throw new Error('native modules resolved but are empty');
    // Exercise the FFI layer immediately — a broken binding surfaces HERE with
    // a clear step name, not later mid-playback. Room allocates its native
    // handle on construction; AudioSource does the same and can be closed.
    try {
      const probe = new rtc.Room();
      void probe; // handle intentionally left for GC — Room has no sync close()
      const probeSource = new rtc.AudioSource(SAMPLE_RATE, CHANNELS);
      await probeSource.close();
    } catch (error) {
      throw new Error(`native runtime loaded but Room/AudioSource construction failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return undefined;
  }, () => `rtc-node=${packageVersion('@livekit/rtc-node')} ffi-bindings=${packageVersion('@livekit/rtc-ffi-bindings')}`);

  // Step 3 — ffmpeg discovery + version probe.
  await runStep('ffmpeg-discovery', async () => {
    const bin = await resolveFfmpeg();
    if (!bin) {
      throw new Error('ffmpeg executable not found — the production image must install ffmpeg (apt-get install -y ffmpeg in the runner stage).');
    }
    resolvedFfmpegPath = bin;
    return await ffmpegVersion(bin);
  }, (version) => version);

  // Step 4 — LiveKit access token (created once, used in step 5).
  const jwt = await runStep('token-create', async () => {
    const at = new AccessToken(apiKey!, apiSecret!, { identity: identity!, name: 'Mahyar Music', ttl: '2h', metadata: JSON.stringify({ bot: 'mahyar-music', room: roomId }) });
    at.addGrant({ roomJoin: true, room: roomId!, canPublish: true, canSubscribe: false, canPublishData: false });
    const token = await at.toJwt();
    if (!token || token.length < 32) throw new Error('AccessToken.toJwt() returned an empty/short token — check LIVEKIT_API_KEY / LIVEKIT_API_SECRET.');
    return token;
  }, () => `identity=${identity} room=${roomId} ttl=2h (token redacted)`);

  // Step 5 — LiveKit room connection.
  await runStep('room-connect', async () => {
    room = new rtc!.Room();
    room.on(rtc!.RoomEvent.Disconnected, (reason?: unknown) => {
      if (shuttingDown) return;
      stopPlayback();
      send({ type: 'disconnected', reason: sanitizeText(String(reason ?? 'disconnected')) });
    });
    await room.connect(url!, jwt, { autoSubscribe: false, dynacast: false });
    if (!room.localParticipant) throw new Error('room.connect() resolved without a local participant');
    return `connected to ${urlHost(url)}`;
  }, (detail) => detail);

  // Step 6 — AudioSource creation (native resource).
  const source = await runStep('audio-source-create', () => {
    const created = new rtc!.AudioSource(SAMPLE_RATE, CHANNELS);
    return created;
  }, () => `${SAMPLE_RATE}Hz ${CHANNELS}ch`);

  // Step 7 — audio track publication. Only after this is the bot audible.
  const publishedTrack = await runStep('track-publish', async () => {
    const track = rtc!.LocalAudioTrack.createAudioTrack('MahyarMusic Audio', source);
    const TrackPublishOptions = ffi!.TrackPublishOptions as unknown as TrackPublishOptionsCtor;
    await room!.localParticipant!.publishTrack(track, new TrackPublishOptions({}));
    return track;
  }, (track) => `track="${track.name}" sid=${(track as unknown as { sid?: string }).sid ?? 'n/a'}`);

  // Step 8 — ready. The parent may only treat the worker as connected AFTER
  // this message: native runtime loaded, room joined, source created, track live.
  audioSource = source;
  logStep('ready', 'ok', `steps=${startupSteps.length} room=${roomId}`);
  send({ type: 'ready', steps: startupSteps.length });

  void publishedTrack; // kept for diagnostics symmetry

  const participantTimer = setInterval(reportParticipants, PARTICIPANT_REPORT_MS);
  participantTimer.unref?.();

  process.on('message', (message: any) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'play') void startPlayback(String(message.url || ''), Number(message.offset) || 0);
    else if (message.type === 'stop-playback') stopPlayback();
    else if (message.type === 'shutdown') void shutdown();
  });

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
  // Periodic keepalive so the parent can detect a wedged child.
  setInterval(() => send({ type: 'heartbeat' }), 10_000).unref?.();
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  stopPlayback();
  try { audioSource?.close(); } catch { /* ignore */ }
  try { await room?.disconnect(); } catch { /* ignore */ }
  process.exit(0);
}

/** Run main() and make sure ANY fatal startup error is logged before exit. */
main().catch(async (error) => {
  const step = (error as Error & { startupStep?: string }).startupStep || 'unknown-step';
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const stack = error instanceof Error && error.stack ? `\n${error.stack.split('\n').slice(1, 6).join('\n')}` : '';
  await flushAndExit(1, [
    `[MahyarMusic:worker] FATAL during startup — step=${step}`,
    `[MahyarMusic:worker] error=${message}${stack}`,
    `[MahyarMusic:worker] steps so far: ${startupSteps.map((s) => `${s.step}:${s.status}`).join(' → ') || '(none)'}`
  ]);
});

// A crash outside main()'s promise chain must also flush diagnostics first.
process.on('uncaughtException', (error) => {
  void flushAndExit(1, [`[MahyarMusic:worker] uncaughtException: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`]);
});
process.on('unhandledRejection', (reason) => {
  void flushAndExit(1, [`[MahyarMusic:worker] unhandledRejection: ${reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason)}`]);
});
