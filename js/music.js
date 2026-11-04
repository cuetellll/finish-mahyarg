/**
 * Mahyar Music — synchronized browser player.
 *
 * One lightweight HTMLAudioElement per browser plays the private Railway Bucket
 * object directly. The server distributes only queue/timeline state over Socket.IO.
 * There is deliberately no server-side decoder, music worker, FFmpeg playback
 * pipeline, or LiveKit music participant.
 */
(function () {
  'use strict';

  const MUSIC_COMMANDS = [
    { name: '/mp play', args: '<track name>', description: 'Find a track in the shared Music Library and play it for everyone.', hint: 'Searches your server music library.', kind: 'command' },
    { name: '/mp queue', args: '', description: 'Show the upcoming music queue.', hint: '', kind: 'command' },
    { name: '/mp pause', args: '', description: 'Pause playback for everyone.', hint: '', kind: 'command' },
    { name: '/mp resume', args: '', description: 'Resume playback for everyone.', hint: '', kind: 'command' },
    { name: '/mp skip', args: '', description: 'Skip the current track.', hint: '', kind: 'command' },
    { name: '/mp stop', args: '', description: 'Stop playback for everyone.', hint: '', kind: 'command' },
    { name: '/mp nowplaying', args: '', description: 'Show the currently playing track.', hint: '', kind: 'command' }
  ];

  const PLAYER_CONTEXT_PREFIX = 'mahyar-music-player:';
  const VOLUME_KEY = 'mahyar_music_local_volume';
  const MUTE_KEY = 'mahyar_music_local_muted';

  function safeRead(key, fallback) {
    try { return localStorage.getItem(key) ?? fallback; } catch (_) { return fallback; }
  }

  function waitForMetadata(audio, timeoutMs = 8000) {
    if (audio.readyState >= 1) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        audio.removeEventListener('loadedmetadata', onReady);
        audio.removeEventListener('canplay', onReady);
        audio.removeEventListener('error', onError);
        error ? reject(error) : resolve();
      };
      const onReady = () => finish();
      const onError = () => finish(new Error('The audio file could not be loaded. Check the Railway Bucket object and its media response.'));
      const timer = setTimeout(() => finish(new Error('Timed out while loading audio metadata. The storage object may not support media requests.')), timeoutMs);
      audio.addEventListener('loadedmetadata', onReady, { once: true });
      audio.addEventListener('canplay', onReady, { once: true });
      audio.addEventListener('error', onError, { once: true });
    });
  }

  class MahyarMusic {
    constructor(api) {
      this.api = api;
      this.states = new Map();
      this.listeners = new Set();
      this.activeChannelId = null;
      this.playbackId = null;
      this.loadGeneration = 0;
      this.needsGesture = false;
      this.localError = null;
      this.muted = safeRead(MUTE_KEY, 'false') === 'true';
      const storedVolume = Number(safeRead(VOLUME_KEY, '75'));
      this.volume = Number.isFinite(storedVolume) ? Math.max(0, Math.min(100, storedVolume)) : 75;
      this.deafened = false;

      // Keep the audio element outside the application's rerendered DOM. Do not set
      // crossOrigin: anonymous here — the private Bucket URL is intended for ordinary
      // media playback, not Web Audio sample access, so no Bucket CORS rule is needed.
      this.audio = document.createElement('audio');
      this.audio.preload = 'metadata';
      this.audio.autoplay = false;
      this.audio.controls = false;
      this.audio.playsInline = true;
      this.audio.setAttribute('aria-hidden', 'true');
      this.audio.tabIndex = -1;
      Object.assign(this.audio.style, {
        position: 'fixed',
        width: '1px',
        height: '1px',
        left: '-10px',
        bottom: '0',
        opacity: '0',
        pointerEvents: 'none'
      });
      document.body.appendChild(this.audio);
      this.applyLocalAudioSettings();

      this.audio.addEventListener('ended', () => this.onAudioEnded());
      this.audio.addEventListener('error', () => {
        if (!this.activeChannelId || !this.playbackId) return;
        this.localError = 'This browser could not load the audio. Check the signed media URL, object permissions, Content-Type, and storage response.';
        this.notifyActiveState();
      });

      this.syncTimer = setInterval(() => this.correctDrift(), 5000);
    }

    destroy() {
      if (this.syncTimer) clearInterval(this.syncTimer);
      this.syncTimer = null;
      this.loadGeneration += 1;
      this.playbackId = null;
      this.activeChannelId = null;
      try { this.audio.pause(); this.audio.removeAttribute('src'); this.audio.load(); this.audio.remove(); } catch (_) { /* page may already be closing */ }
      this.listeners.clear();
      this.states.clear();
    }

    handleState(state) {
      if (!state || typeof state.channel_id !== 'string') return;
      // Anchor each snapshot to this browser's receive time instead of trusting
      // wall-clock agreement between friends' devices. Small network transit
      // delay remains, but machine clock skew no longer shifts the music timeline.
      const receivedAt = Date.now();
      const localState = {
        ...state,
        now_playing: state.now_playing
          ? { ...state.now_playing, client_received_at: receivedAt }
          : null
      };
      this.states.set(localState.channel_id, localState);
      this.listeners.forEach((cb) => { try { cb(localState); } catch (_) { /* listener error */ } });
      if (localState.channel_id === this.activeChannelId) void this.syncPlayback(localState);
    }

    onState(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
    stateFor(channelId) { return this.states.get(channelId) || null; }

    static isPlayerIdentity(identity) {
      return typeof identity === 'string' && identity.startsWith(PLAYER_CONTEXT_PREFIX);
    }

    commandCatalog() { return MUSIC_COMMANDS.slice(); }

    parse(input) {
      const text = String(input || '').trim();
      if (!text.startsWith('/')) return { command: null };
      const segments = text.slice(1).split(/\s+/);
      const head = (segments[0] || '').toLowerCase();
      if (head !== 'mp') return { command: null };
      const sub = (segments[1] || '').toLowerCase();
      const known = ['play', 'queue', 'pause', 'resume', 'skip', 'stop', 'nowplaying'];
      if (!sub) return { command: 'help', args: '', complete: false };
      if (!known.includes(sub)) return { command: 'unknown', args: segments.slice(2).join(' '), complete: true, error: `Unknown command "/mp ${sub}". Try /mp play <track>.` };
      const args = text.slice(1).replace(/^\s*mp\s+\S+/i, '').trim();
      return { command: sub, args, complete: true };
    }

    playSearchTerm(input) {
      const match = /^\s*\/mp\s+play\s+(.{1,120})$/i.exec(String(input || ''));
      return match ? match[1].trim() : null;
    }

    async execute(channelId, parsed) {
      if (!parsed || !parsed.command) return { ok: false, error: 'Not a music command.' };
      switch (parsed.command) {
        case 'play':
          if (!parsed.args) return { ok: false, error: 'Usage: /mp play <track name>' };
          return await this.api.musicCommand(channelId, 'play', { query: parsed.args });
        case 'pick':
          return await this.api.musicCommand(channelId, 'pick', { track_id: parsed.args });
        case 'pause': return await this.api.musicCommand(channelId, 'pause');
        case 'resume': return await this.api.musicCommand(channelId, 'resume');
        case 'skip': return await this.api.musicCommand(channelId, 'skip');
        case 'stop': return await this.api.musicCommand(channelId, 'stop');
        case 'queue': return await this.api.musicCommand(channelId, 'queue');
        case 'nowplaying': return await this.api.musicCommand(channelId, 'nowplaying');
        case 'help':
          return { ok: false, error: 'Mahyar Music: /mp play, /mp queue, /mp pause, /mp resume, /mp skip, /mp stop, /mp nowplaying.' };
        case 'unknown':
          return { ok: false, error: parsed.error || 'Unknown music command.' };
        default:
          return { ok: false, error: 'Unknown music command.' };
      }
    }

    async search(channelId, query) {
      return await this.api.musicCommand(channelId, 'search', { query });
    }

    setActiveChannel(channelId) {
      const next = channelId || null;
      if (next === this.activeChannelId) return;
      this.activeChannelId = next;
      this.loadGeneration += 1;
      this.playbackId = null;
      this.needsGesture = false;
      this.localError = null;
      // Always stop the previous channel before considering the new one. Without
      // this, switching Voice rooms could leave the old room's music playing.
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
      if (!next) return;
      const state = this.states.get(next);
      if (state) void this.syncPlayback(state);
    }

    getVolume() { return this.volume; }
    isMuted() { return this.muted; }

    setVolume(value) {
      const volume = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
      this.volume = volume;
      if (volume > 0 && this.muted) this.muted = false;
      try {
        localStorage.setItem(VOLUME_KEY, String(volume));
        localStorage.setItem(MUTE_KEY, String(this.muted));
      } catch (_) { /* storage may be unavailable */ }
      this.applyLocalAudioSettings();
      this.notifyActiveState();
      return this.volume;
    }

    toggleMute() {
      this.muted = !this.muted;
      try { localStorage.setItem(MUTE_KEY, String(this.muted)); } catch (_) { /* ignore */ }
      this.applyLocalAudioSettings();
      this.notifyActiveState();
      return this.volume;
    }

    setDeafened(value) {
      this.deafened = Boolean(value);
      this.applyLocalAudioSettings();
    }

    applyLocalAudioSettings() {
      if (!this.audio) return;
      this.audio.volume = Math.max(0, Math.min(1, this.volume / 100));
      this.audio.muted = this.muted || this.deafened;
    }

    currentPosition(np) {
      if (!np) return 0;
      const base = Math.max(0, Number(np.position) || 0);
      const stamp = Number(np.client_received_at) || Number(np.position_ts) || Date.now();
      const elapsed = np.paused ? 0 : Math.max(0, (Date.now() - stamp) / 1000);
      const duration = Number(np.duration) || Infinity;
      return Math.min(duration, base + elapsed);
    }

    async syncPlayback(state) {
      if (!state || state.channel_id !== this.activeChannelId) return;
      const np = state.now_playing;
      if (!np) {
        this.loadGeneration += 1;
        this.playbackId = null;
        this.needsGesture = false;
        this.localError = null;
        this.audio.pause();
        this.audio.removeAttribute('src');
        this.audio.load();
        this.notifyActiveState(state);
        return;
      }

      const nextPlaybackId = np.playback_id || `${np.track_id || np.id}:${np.started_at || ''}`;
      const targetPosition = this.currentPosition(np);
      const trackId = np.track_id || String(np.id || '').replace(/^lib:/, '');
      if (!trackId) {
        this.localError = 'The playback state does not contain a valid track ID.';
        this.notifyActiveState(state);
        return;
      }

      if (this.playbackId !== nextPlaybackId || !this.audio.src) {
        const loadId = ++this.loadGeneration;
        this.playbackId = nextPlaybackId;
        this.localError = null;
        this.needsGesture = false;
        this.audio.pause();
        this.audio.removeAttribute('src');
        this.audio.load();

        try {
          const result = await this.api.musicPlaybackUrl(state.channel_id, trackId);
          if (loadId !== this.loadGeneration || state.channel_id !== this.activeChannelId) return;
          if (!result?.url) throw new Error('The server did not return a playable audio URL.');
          this.audio.src = result.url;
          this.audio.load();
          await waitForMetadata(this.audio);
          if (loadId !== this.loadGeneration || state.channel_id !== this.activeChannelId) return;

          // The URL fetch and metadata load may take several seconds. Re-read the
          // latest server state so every browser seeks against the same timeline.
          const latestState = this.states.get(state.channel_id) || state;
          const latestNp = latestState.now_playing;
          if (!latestNp || (latestNp.playback_id || `${latestNp.track_id}:${latestNp.started_at}`) !== nextPlaybackId) return;
          this.seekTo(this.currentPosition(latestNp));
          this.applyLocalAudioSettings();
          if (!latestNp.paused) await this.tryPlay(latestState);
          else this.audio.pause();
        } catch (error) {
          if (loadId !== this.loadGeneration) return;
          this.localError = error instanceof Error ? error.message : 'The audio track could not be loaded.';
          this.needsGesture = false;
          this.notifyActiveState(state);
        }
        return;
      }

      // A state update for the same playback: pause/resume immediately and correct
      // small timeline drift without repeatedly restarting the underlying media.
      if (np.paused) {
        this.audio.pause();
        this.seekTo(targetPosition);
      } else {
        if (this.audio.readyState >= 1 && Math.abs(this.audio.currentTime - targetPosition) > 1.75) {
          this.seekTo(targetPosition);
        }
        if (this.audio.paused) await this.tryPlay(state);
      }
      this.applyLocalAudioSettings();
      this.notifyActiveState(state);
    }

    seekTo(seconds) {
      if (!Number.isFinite(seconds) || this.audio.readyState < 1) return;
      const max = Number.isFinite(this.audio.duration) ? Math.max(0, this.audio.duration - 0.15) : seconds;
      try { this.audio.currentTime = Math.max(0, Math.min(max, seconds)); } catch (_) { /* metadata may still be settling */ }
    }

    async tryPlay(state) {
      if (!this.audio.src) return false;
      this.applyLocalAudioSettings();
      try {
        await this.audio.play();
        this.needsGesture = false;
        this.localError = null;
        this.notifyActiveState(state);
        return true;
      } catch (error) {
        if (error?.name === 'NotAllowedError') {
          this.needsGesture = true;
          this.localError = null;
        } else {
          this.localError = error instanceof Error ? error.message : 'The browser could not start audio playback.';
        }
        this.notifyActiveState(state);
        return false;
      }
    }

    /** Must be called directly from a user click to satisfy browser autoplay policy. */
    async enableAudio() {
      if (!this.activeChannelId || !this.audio.src) return false;
      this.applyLocalAudioSettings();
      try {
        await this.audio.play();
        this.needsGesture = false;
        this.localError = null;
        this.notifyActiveState();
        return true;
      } catch (error) {
        this.localError = error instanceof Error ? error.message : 'Audio playback is blocked by this browser.';
        this.needsGesture = error?.name === 'NotAllowedError';
        this.notifyActiveState();
        return false;
      }
    }

    correctDrift() {
      const state = this.activeChannelId ? this.states.get(this.activeChannelId) : null;
      const np = state?.now_playing;
      if (!np || np.paused || this.audio.paused || this.audio.readyState < 1) return;
      const target = this.currentPosition(np);
      const drift = Math.abs(this.audio.currentTime - target);
      if (drift > 1.75) this.seekTo(target);
    }

    async onAudioEnded() {
      const state = this.activeChannelId ? this.states.get(this.activeChannelId) : null;
      const np = state?.now_playing;
      if (!state || !np?.track_id || !np?.playback_id) return;
      try {
        const result = await this.api.musicCommand(state.channel_id, 'ended', {
          track_id: np.track_id,
          playback_id: np.playback_id
        });
        if (result?.state) this.handleState(result.state);
      } catch (_) { /* the server-side duration timer is the fallback */ }
    }

    notifyActiveState(fallbackState) {
      const state = fallbackState || (this.activeChannelId ? this.states.get(this.activeChannelId) : null);
      if (!state) return;
      this.listeners.forEach((cb) => { try { cb({ ...state, local_needs_gesture: this.needsGesture, local_playback_error: this.localError, local_volume: this.volume, local_muted: this.muted }); } catch (_) { /* listener error */ } });
    }

    formatDuration(seconds) {
      const total = Math.max(0, Math.round(Number(seconds) || 0));
      const minutes = Math.floor(total / 60);
      const remainder = total % 60;
      return `${minutes}:${String(remainder).padStart(2, '0')}`;
    }
  }

  MahyarMusic.PLAYER_CONTEXT_PREFIX = PLAYER_CONTEXT_PREFIX;
  window.MahyarMusic = MahyarMusic;
})();