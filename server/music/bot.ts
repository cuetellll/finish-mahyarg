/**
 * Mahyar Music — bot worker manager (parent side).
 *
 * The manager owns the worker child process per voice room. The child (see
 * worker-main.ts) holds the real @livekit/rtc-node connection and the ffmpeg
 * decoder; isolating it means a wedged native runtime or a crashed decoder can
 * never take down the main HTTP server, and every teardown is a process exit.
 *
 * Contract with the engine (BotEvents):
 *  - onTrackEnded()      : current decode reached EOF
 *  - onConnectionLost()  : worker died or LiveKit connection dropped
 *  - onDurationKnown(s)  : ffmpeg reported the real duration
 *  - onFatalError(msg)   : playback-level failure (engine advances the queue)
 *
 * Startup contract: a worker is "ready" (and `connected` returns true) ONLY
 * after the child reported the full startup sequence — native runtime loaded,
 * LiveKit room joined, AudioSource created, audio track published. Any failure
 * before that is surfaced with exit code, signal and sanitized output tails,
 * and a per-room circuit breaker stops the engine from respawning in a loop.
 */
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { boundedTail, sanitizeText, tailSummary } from './diagnostics';

export interface BotEvents {
  onTrackEnded: () => void;
  onConnectionLost: (reason: string) => void;
  onDurationKnown: (seconds: number) => void;
  onFatalError: (message: string) => void;
}

const READY_TIMEOUT_MS = 20_000;
const HEARTBEAT_TIMEOUT_MS = 35_000;

/**
 * Circuit breaker (per voice room, shared across worker instances): if startup
 * failed this many times inside the window, further ensureConnected() calls
 * fail fast instead of spawning more doomed workers.
 */
const BREAKER_MAX_FAILURES = 3;
const BREAKER_WINDOW_MS = 60_000;
const BREAKER_COOLDOWN_MS = 30_000;
const breakerFailures = new Map<string, number[]>(); // roomId → failure timestamps

function breakerAllows(roomId: string): { ok: true } | { ok: false; message: string } {
  const now = Date.now();
  const recent = (breakerFailures.get(roomId) || []).filter((ts) => now - ts < BREAKER_WINDOW_MS + BREAKER_COOLDOWN_MS);
  breakerFailures.set(roomId, recent);
  const inWindow = recent.filter((ts) => now - ts < BREAKER_WINDOW_MS);
  if (inWindow.length >= BREAKER_MAX_FAILURES) {
    const lastAt = inWindow[inWindow.length - 1];
    const waitSeconds = Math.max(1, Math.ceil((BREAKER_COOLDOWN_MS - (now - lastAt)) / 1000));
    return {
      ok: false,
      message: `Music worker for this room failed to start ${inWindow.length} times in the last minute (last error at ${new Date(lastAt).toISOString()}). Retries are paused for ~${waitSeconds}s to protect the server — check the Railway Deploy Logs for the worker's step-by-step startup diagnostics before trying again.`
    };
  }
  return { ok: true };
}

function breakerRecordFailure(roomId: string) {
  const now = Date.now();
  const recent = (breakerFailures.get(roomId) || []).filter((ts) => now - ts < BREAKER_WINDOW_MS + BREAKER_COOLDOWN_MS);
  recent.push(now);
  breakerFailures.set(roomId, recent);
}

function breakerRecordSuccess(roomId: string) {
  breakerFailures.delete(roomId);
}

interface StreamTails { stdout: string; stderr: string }

export class MusicBotWorker {
  readonly identity: string;
  private child: ChildProcess | null = null;
  private ready = false;
  private lastHeartbeatAt = 0;
  private humanCount = 0;
  private stopping = false;
  private starting: Promise<void> | null = null;
  private currentUrl: string | null = null;
  private currentOffset = 0;
  private playingFlag = false;
  private lastStartupError: string | null = null;
  private events: BotEvents;

  constructor(
    private readonly liveKitUrl: string,
    private readonly apiKey: string,
    private readonly apiSecret: string,
    private readonly roomId: string,
    events: BotEvents
  ) {
    this.identity = `mahyar-music:${roomId}`;
    this.events = events;
  }

  /** Worker process alive and reporting. */
  get connected(): boolean {
    return Boolean(this.child && this.ready && !this.stopping && this.child.exitCode === null);
  }

  get humanParticipantCount(): number { return this.humanCount; }
  get playing(): boolean { return this.playingFlag; }
  get currentStreamUrl(): string | null { return this.currentUrl; }
  get playbackOffset(): number { return this.currentOffset; }
  /** Last actionable startup failure (breaker messages included). */
  get startupError(): string | null { return this.lastStartupError; }

  private workerEntry(): string {
    // dist/server/music/worker-main.js sits next to this compiled file.
    return path.join(__dirname, 'worker-main.js');
  }

  /** Secrets that must never leak through captured worker output. */
  private secrets(): Array<string | undefined> {
    return [this.apiKey, this.apiSecret, this.liveKitUrl];
  }

  /** Spawn the worker and wait until it reports the room joined + track published. */
  async ensureConnected(): Promise<void> {
    if (this.connected) return;
    if (this.starting) return this.starting;

    // Fail fast instead of spawning yet another doomed worker (FIX 4).
    const breaker = breakerAllows(this.roomId);
    if (!breaker.ok) {
      this.lastStartupError = breaker.message;
      console.warn(`[MahyarMusic] spawn blocked by startup breaker for room ${this.roomId}: ${breaker.message}`);
      throw new Error(breaker.message);
    }

    this.starting = (async () => {
      try {
        this.stopping = false;
        this.ready = false;
        this.playingFlag = false;
        this.humanCount = 0;
        this.lastStartupError = null;

        const child = spawn(process.execPath, [this.workerEntry()], {
          env: {
            ...process.env,
            MUSIC_WORKER_INIT: JSON.stringify({ url: this.liveKitUrl, apiKey: this.apiKey, apiSecret: this.apiSecret, roomId: this.roomId, identity: this.identity })
          },
          stdio: ['ipc', 'pipe', 'pipe']
        });
        this.child = child;

        // Keep stdout and stderr tails SEPARATE (FIX 3): rtc-node logs to stdout,
        // Node errors/warnings to stderr. Both are bounded and sanitized.
        const tails: StreamTails = { stdout: '', stderr: '' };
        child.stdout?.on('data', (chunk: Buffer) => {
          tails.stdout = boundedTail(tails.stdout, chunk.toString());
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          tails.stderr = boundedTail(tails.stderr, chunk.toString());
        });

        child.on('message', (message: any) => this.handleWorkerMessage(message));

        // Spawn/IPC failures (ENOENT, EAGAIN...) must reject the startup wait
        // instead of hanging until the ready timeout.
        let spawnError: Error | null = null;
        child.on('error', (error) => {
          spawnError = error;
          console.error(`[MahyarMusic] worker spawn error for room ${this.roomId}: ${error.message}`);
        });

        console.log(`[MahyarMusic] worker spawned for room ${this.roomId} (pid ${child.pid})`);

        child.on('exit', (code, signal) => {
          const wasReady = this.ready;
          this.ready = false;
          this.playingFlag = false;
          this.child = null;
          if (this.stopping) return;
          if (wasReady) this.events.onConnectionLost(`worker exited (code ${code} ${signal || ''})`.trim());
        });

        // Wait for 'ready' with a hard timeout; a worker that cannot join is killed.
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            // A wedged (alive but silent) worker must not leak: kill it.
            try { child.kill('SIGKILL'); } catch { /* already dead */ }
            reject(new Error(`Music worker did not become ready in ${READY_TIMEOUT_MS} ms (pid ${child.pid}).`));
          }, READY_TIMEOUT_MS);

          const fail = (error: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
          };

          child.once('message', function onStartupMessage(message: any) {
            if (message?.type === 'ready') { clearTimeout(timer); resolve(); return; }
            if (message?.type === 'fatal' || message?.type === 'fatal-error') {
              const step = message.step ? ` (failed at step "${message.step}")` : '';
              fail(new Error(`Music worker reported a fatal error during startup${step}: ${sanitizeText(String(message.message || 'unknown cause'))}`));
            }
          });

          child.once('exit', (code, signal) => {
            fail(this.startupExitError(code, signal, tails, spawnError));
          });
        });

        this.ready = true;
        this.lastHeartbeatAt = Date.now();
        breakerRecordSuccess(this.roomId);
        console.log(`[MahyarMusic] worker ready for room ${this.roomId} (pid ${child.pid})`);
      } catch (error) {
        // Any startup failure feeds the per-room circuit breaker.
        breakerRecordFailure(this.roomId);
        if (error instanceof Error) {
          this.lastStartupError = sanitizeText(error.message, this.secrets());
          console.error(`[MahyarMusic] worker startup failed for room ${this.roomId}: ${this.lastStartupError}`);
        }
        throw error;
      } finally {
        this.starting = null;
      }
    })();
    return this.starting;
  }

  /**
   * Build a diagnosable error for a worker that exited before becoming ready:
   * exit code AND termination signal, plus sanitized stdout/stderr tails.
   * The same block is written to the server log so it lands in the Railway
   * Deploy Logs verbatim.
   */
  private startupExitError(code: number | null, signal: NodeJS.Signals | null, tails: StreamTails, spawnError: Error | null): Error {
    const reason = spawnError
      ? `spawn failed: ${spawnError.message}`
      : `exited during startup (code ${code ?? 'null'}, signal ${signal ?? 'none'})`;
    const stdoutLines = tailSummary(sanitizeText(tails.stdout, this.secrets()));
    const stderrLines = tailSummary(sanitizeText(tails.stderr, this.secrets()));

    const detailLines = [
      `[MahyarMusic] Music worker for room ${this.roomId} ${reason}.`,
      stdoutLines ? `[MahyarMusic] worker stdout (tail): ${stdoutLines}` : '[MahyarMusic] worker stdout (tail): (empty)',
      stderrLines ? `[MahyarMusic] worker stderr (tail): ${stderrLines}` : '[MahyarMusic] worker stderr (tail): (empty)',
      '[MahyarMusic] Hint: a native module or ffmpeg problem shows the failing startup step in the lines above (step=<name> status=failed).'
    ];
    // Multi-line dump → visible in Railway Deploy Logs.
    console.error(detailLines.join('\n'));

    const summary = `Music worker ${reason}.${stdoutLines ? ` stdout: ${stdoutLines}` : ''}${stderrLines ? ` stderr: ${stderrLines}` : ''}`;
    return new Error(summary.length > 1_200 ? `${summary.slice(0, 1_200)}…` : summary);
  }

  private handleWorkerMessage(message: any) {
    if (!message || typeof message !== 'object') return;
    switch (message.type) {
      case 'startup-log': {
        // Per-step startup trace from the child — always logged (Railway Deploy Logs).
        const step = String(message.step || '?');
        const status = String(message.status || '?');
        const detail = message.detail ? ` ${sanitizeText(String(message.detail), this.secrets())}` : '';
        const line = `[MahyarMusic] worker ${this.roomId} startup ${status}: ${step}${detail}`;
        if (status === 'failed') console.error(line); else console.log(line);
        break;
      }
      case 'ready':
        this.ready = true;
        this.lastHeartbeatAt = Date.now();
        break;
      case 'playing':
        this.playingFlag = true;
        break;
      case 'duration':
        if (Number(message.seconds) > 0) this.events.onDurationKnown(Number(message.seconds));
        break;
      case 'track-ended':
        this.playingFlag = false;
        this.currentUrl = null;
        this.events.onTrackEnded();
        break;
      case 'fatal-error':
        this.playingFlag = false;
        this.events.onFatalError(sanitizeText(String(message.message || 'Playback failed.'), this.secrets()));
        break;
      case 'disconnected':
        this.ready = false;
        this.playingFlag = false;
        this.events.onConnectionLost(sanitizeText(String(message.reason || 'LiveKit disconnected'), this.secrets()));
        break;
      case 'participants':
        this.humanCount = Math.max(0, Number(message.count) || 0);
        this.lastHeartbeatAt = Date.now();
        break;
      case 'heartbeat':
        this.lastHeartbeatAt = Date.now();
        break;
      case 'decode-debug':
        if (process.env.MUSIC_DEBUG) console.log(`[MahyarMusic][worker] ${sanitizeText(String(message.message || ''), this.secrets())}`);
        break;
      case 'fatal':
        // Worker cannot continue at all: treat like a lost connection.
        this.ready = false;
        this.playingFlag = false;
        this.events.onConnectionLost(sanitizeText(String(message.message || 'worker fatal'), this.secrets()));
        break;
      default:
        break;
    }
  }

  /** True when the worker stopped responding (used by the engine sweeper). */
  isStale(): boolean {
    return this.connected && Date.now() - this.lastHeartbeatAt > HEARTBEAT_TIMEOUT_MS;
  }

  /** Start playing a stream URL. Resolves once the decoder is producing audio. */
  async play(url: string, offsetSeconds = 0): Promise<void> {
    if (!this.connected) throw new Error('Bot is not connected');
    this.send({ type: 'stop-playback' });
    this.playingFlag = false;
    this.currentUrl = url;
    this.currentOffset = offsetSeconds;
    await new Promise<void>((resolve, reject) => {
      const child = this.child!;
      const timer = setTimeout(() => {
        child.removeListener('message', onMessage);
        reject(new Error('Music worker did not acknowledge the new track in time.'));
      }, READY_TIMEOUT_MS);
      const onMessage = (message: any) => {
        if (message?.type === 'playing') { clearTimeout(timer); child.removeListener('message', onMessage); resolve(); }
        else if (message?.type === 'fatal-error') { clearTimeout(timer); child.removeListener('message', onMessage); reject(new Error(sanitizeText(String(message.message), this.secrets()))); }
      };
      child.on('message', onMessage);
      this.send({ type: 'play', url, offset: offsetSeconds });
    });
  }

  /** Stop the current decode without killing the worker. */
  stopPlayback(): void {
    this.playingFlag = false;
    this.currentUrl = null;
    this.send({ type: 'stop-playback' });
  }

  /** Kill the worker; the child releases LiveKit + ffmpeg on exit. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.ready = false;
    this.playingFlag = false;
    const child = this.child;
    this.child = null;
    if (!child) return;
    try { this.send({ type: 'shutdown' }); } catch { /* ipc gone */ }
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    try { child.kill('SIGTERM'); } catch { /* already dead */ }
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 3_000));
    await Promise.race([exited, timeout]);
    if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
  }

  private send(message: Record<string, unknown>) {
    try { this.child?.connected && this.child.send(message); } catch { /* child gone */ }
  }
}
