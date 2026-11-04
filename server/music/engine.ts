/**
 * Mahyar Music — synchronized browser playback engine.
 *
 * The server is authoritative for queue and playback timeline only. It does
 * NOT decode, relay, or publish audio. Each authorized browser plays the same
 * private Railway Bucket object through its own HTMLAudioElement.
 *
 * This removes the native LiveKit music worker and FFmpeg playback pipeline.
 * LiveKit remains responsible for human voice/video only.
 */
import { randomUUID } from 'crypto';
import type { Server as SocketIOServer } from 'socket.io';
import { MusicTrack, MusicLibraryResolver, NowPlaying, PublicMusicState, QueueEntry } from './types';

const MAX_QUEUE_SIZE = Math.min(100, Math.max(1, Number(process.env.MUSIC_MAX_QUEUE) || 50));
const PLAY_COMMAND_COOLDOWN_MS = 1_000;
const SEARCH_SESSION_TTL_MS = 5 * 60_000;
const ROOM_IDLE_TTL_MS = 15 * 60_000;
const TRACK_END_GRACE_MS = 500;

interface MusicRoom {
  channelId: string;
  serverId: string;
  queue: QueueEntry[];
  nowPlaying: NowPlaying | null;
  paused: boolean;
  pausedAt: number;
  lastError: string | null;
  lastActivityAt: number;
  endTimer: ReturnType<typeof setTimeout> | null;
  recentPlays: Map<string, number>;
  searchSessions: Map<string, { tracks: MusicTrack[]; expiresAt: number }>;
}

export interface MusicDeps {
  io: SocketIOServer;
  library: MusicLibraryResolver;
}

export class MusicEngine {
  private rooms = new Map<string, MusicRoom>();
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(private deps: MusicDeps) {
    this.sweeper = setInterval(() => this.sweep(), 30_000);
    this.sweeper.unref?.();
  }

  get library(): MusicLibraryResolver {
    return this.deps.library;
  }

  private room(channelId: string, serverId: string): MusicRoom {
    let room = this.rooms.get(channelId);
    if (!room) {
      room = {
        channelId,
        serverId,
        queue: [],
        nowPlaying: null,
        paused: false,
        pausedAt: 0,
        lastError: null,
        lastActivityAt: Date.now(),
        endTimer: null,
        recentPlays: new Map(),
        searchSessions: new Map()
      };
      this.rooms.set(channelId, room);
    }
    room.lastActivityAt = Date.now();
    return room;
  }

  private touch(room: MusicRoom) {
    room.lastActivityAt = Date.now();
  }

  private currentPosition(room: MusicRoom, now = Date.now()): number {
    if (!room.nowPlaying) return 0;
    const end = room.paused ? room.pausedAt : now;
    return Math.max(0, room.nowPlaying.offsetSeconds + (end - room.nowPlaying.startedAt) / 1000);
  }

  /** Public state contains metadata and a server-anchored timeline, never a signed URL. */
  private publicState(room: MusicRoom): PublicMusicState {
    const timestamp = Date.now();
    const nowPlaying = room.nowPlaying
      ? (() => {
          const position = Math.min(
            room.nowPlaying.track.duration || Infinity,
            this.currentPosition(room, timestamp)
          );
          return {
            id: room.nowPlaying.track.id,
            track_id: room.nowPlaying.track.trackId,
            playback_id: room.nowPlaying.playbackId,
            title: room.nowPlaying.track.title,
            artist: room.nowPlaying.track.artist,
            origin: room.nowPlaying.track.origin,
            artwork_url: room.nowPlaying.track.artworkUrl || null,
            duration: room.nowPlaying.track.duration,
            requester_id: room.nowPlaying.requesterId,
            position: Number.isFinite(position) ? Math.round(position * 100) / 100 : 0,
            position_ts: timestamp,
            started_at: room.nowPlaying.startedAt,
            paused: room.paused
          };
        })()
      : null;

    return {
      channel_id: room.channelId,
      server_id: room.serverId,
      // Kept as backwards-compatible fields for older clients. The synchronized
      // browser player is not a LiveKit participant.
      bot_connected: false,
      bot_identity: null,
      player_mode: 'synchronized-browser',
      now_playing: nowPlaying,
      queue: room.queue.slice(0, MAX_QUEUE_SIZE).map((entry, index) => ({
        position: index + 1,
        id: entry.track.id,
        track_id: entry.track.trackId,
        title: entry.track.title,
        artist: entry.track.artist,
        origin: entry.track.origin,
        artwork_url: entry.track.artworkUrl || null,
        duration: entry.track.duration,
        requester_id: entry.requesterId
      })),
      last_error: room.lastError
    };
  }

  private emit(room: MusicRoom) {
    this.deps.io.to(`music:${room.channelId}`).emit('music:state', this.publicState(room));
  }

  private clearEndTimer(room: MusicRoom) {
    if (room.endTimer) clearTimeout(room.endTimer);
    room.endTimer = null;
  }

  private scheduleTrackEnd(room: MusicRoom) {
    this.clearEndTimer(room);
    const current = room.nowPlaying;
    if (!current || room.paused || !current.track.duration) return;

    const playbackId = current.playbackId;
    const remainingSeconds = Math.max(0, current.track.duration - this.currentPosition(room));
    room.endTimer = setTimeout(() => {
      room.endTimer = null;
      if (!room.nowPlaying || room.nowPlaying.playbackId !== playbackId || room.paused) return;
      const remaining = room.nowPlaying.track.duration - this.currentPosition(room);
      if (remaining > 0.35) {
        this.scheduleTrackEnd(room);
        return;
      }
      room.nowPlaying = null;
      this.touch(room);
      void this.advance(room, undefined);
    }, Math.max(250, remainingSeconds * 1000 + TRACK_END_GRACE_MS));
    room.endTimer.unref?.();
  }

  private advance(room: MusicRoom, requesterId?: string): Promise<void> {
    const next = room.queue.shift();
    if (!next) {
      this.clearEndTimer(room);
      room.nowPlaying = null;
      room.paused = false;
      room.pausedAt = 0;
      room.lastError = null;
      this.touch(room);
      this.emit(room);
      return Promise.resolve();
    }
    return this.startTrack(room, next.track, next.requesterId || requesterId || '');
  }

  private async startTrack(room: MusicRoom, track: MusicTrack, requesterId: string, offsetSeconds = 0): Promise<void> {
    if (!track.streamable || !track.trackId) {
      room.lastError = track.unavailableReason || 'This track is not available in the shared library.';
      this.emit(room);
      await this.advance(room, requesterId);
      return;
    }

    this.clearEndTimer(room);
    room.nowPlaying = {
      track,
      requesterId,
      startedAt: Date.now(),
      offsetSeconds: Math.max(0, offsetSeconds),
      playbackId: randomUUID()
    };
    room.paused = false;
    room.pausedAt = 0;
    room.lastError = null;
    this.touch(room);
    this.deps.library.recordPlay(track.trackId);
    this.scheduleTrackEnd(room);
    this.emit(room);
    console.log(`[MahyarMusic] synchronized playback started: "${track.title}" in ${room.channelId}`);
  }

  private sweep() {
    const now = Date.now();
    for (const [channelId, room] of this.rooms) {
      for (const [userId, session] of room.searchSessions) {
        if (session.expiresAt <= now) room.searchSessions.delete(userId);
      }
      for (const [userId, timestamp] of room.recentPlays) {
        if (now - timestamp > PLAY_COMMAND_COOLDOWN_MS * 10) room.recentPlays.delete(userId);
      }
      if (!room.nowPlaying && room.queue.length === 0 && room.searchSessions.size === 0 &&
          now - room.lastActivityAt > ROOM_IDLE_TTL_MS) {
        this.clearEndTimer(room);
        this.rooms.delete(channelId);
      }
    }
  }

  async destroyRoom(channelId: string) {
    const room = this.rooms.get(channelId);
    if (!room) return;
    this.clearEndTimer(room);
    room.nowPlaying = null;
    room.queue = [];
    room.paused = false;
    room.searchSessions.clear();
    this.rooms.delete(channelId);
    this.deps.io.to(`music:${channelId}`).emit('music:state', this.emptyState(channelId, room.serverId));
  }

  async shutdown() {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    for (const room of this.rooms.values()) this.clearEndTimer(room);
    this.rooms.clear();
  }

  // --------------------------------------------------------------- commands

  state(channelId: string, serverId = ''): PublicMusicState {
    const room = this.rooms.get(channelId);
    return room ? this.publicState(room) : this.emptyState(channelId, serverId);
  }

  private emptyState(channelId: string, serverId: string): PublicMusicState {
    return {
      channel_id: channelId,
      server_id: serverId,
      bot_connected: false,
      bot_identity: null,
      player_mode: 'synchronized-browser',
      now_playing: null,
      queue: [],
      last_error: null
    };
  }

  private duplicateGuard(room: MusicRoom, userId: string): boolean {
    const last = room.recentPlays.get(userId) || 0;
    const now = Date.now();
    if (now - last < PLAY_COMMAND_COOLDOWN_MS) return false;
    room.recentPlays.set(userId, now);
    return true;
  }

  private async enqueue(room: MusicRoom, tracks: MusicTrack[], requesterId: string): Promise<{ ok: boolean; message: string }> {
    const usable = tracks.filter((track) => track.streamable && Boolean(track.trackId));
    if (!usable.length) return { ok: false, message: tracks[0]?.unavailableReason || 'No playable tracks were found.' };
    if (room.queue.length + usable.length > MAX_QUEUE_SIZE) {
      return { ok: false, message: `The queue is full (maximum ${MAX_QUEUE_SIZE} tracks).` };
    }
    for (const track of usable) room.queue.push({ track, requesterId, addedAt: Date.now() });
    if (!room.nowPlaying) await this.advance(room, requesterId);
    this.touch(room);
    this.emit(room);
    const skipped = tracks.length - usable.length;
    const note = skipped ? ` ${skipped} unavailable track(s) were skipped.` : '';
    return {
      ok: true,
      message: usable.length > 1
        ? `Added ${usable.length} tracks to the shared queue.${note}`
        : `Added "${usable[0].title}" to the shared queue.${note}`
    };
  }

  /** `/mp play <query>` — search the server library and start synchronized playback. */
  async play(params: {
    channelId: string; serverId: string; userId: string; query: string; trackRef?: string;
  }): Promise<{ ok: boolean; message: string; state: PublicMusicState }> {
    const room = this.room(params.channelId, params.serverId);
    if (!this.duplicateGuard(room, params.userId)) {
      return { ok: false, message: 'A music request is already being processed. Try again in a moment.', state: this.publicState(room) };
    }

    const trimmed = params.query.trim();
    let picked: MusicTrack[] = [];
    let pickList: MusicTrack[] | null = null;

    if (/^https?:\/\//i.test(trimmed)) {
      return {
        ok: false,
        message: 'External music links are not supported. Upload the audio file to this server library first.',
        state: this.publicState(room)
      };
    } else if (params.trackRef) {
      const session = room.searchSessions.get(params.userId);
      const fromSession = session?.tracks.find((track) => track.trackId === params.trackRef || track.id === params.trackRef);
      if (fromSession) {
        session!.tracks = session!.tracks.filter((track) => track !== fromSession);
        picked = [fromSession];
      } else {
        const fresh = await this.deps.library.getPlayableTrack(params.serverId, String(params.trackRef));
        if (!fresh) return { ok: false, message: 'That track is not in this server library.', state: this.publicState(room) };
        picked = [fresh];
      }
    } else if (!trimmed) {
      return { ok: false, message: 'Enter a track name from your server music library.', state: this.publicState(room) };
    } else {
      const results = await this.deps.library.searchTracks(params.serverId, trimmed, 5);
      const playable = results.filter((track) => track.streamable && Boolean(track.trackId));
      if (!playable.length) {
        return {
          ok: false,
          message: results.length
            ? 'Matching tracks were found, but none are currently playable.'
            : `No track matching "${trimmed.slice(0, 60)}" was found. Upload it to the Music Library first.`,
          state: this.publicState(room)
        };
      }
      if (playable.length === 1) picked = [playable[0]];
      else {
        room.searchSessions.set(params.userId, { tracks: playable, expiresAt: Date.now() + SEARCH_SESSION_TTL_MS });
        pickList = playable;
      }
    }

    if (pickList) return { ok: true, message: 'PICK_RESULT', state: this.publicState(room) };
    const result = await this.enqueue(room, picked, params.userId);
    return { ok: result.ok, message: result.message, state: this.publicState(room) };
  }

  async search(params: {
    channelId: string; serverId: string; userId: string; query: string;
  }): Promise<{ ok: boolean; tracks: MusicTrack[]; message: string }> {
    const room = this.room(params.channelId, params.serverId);
    const results = await this.deps.library.searchTracks(params.serverId, params.query, 6);
    const playable = results.filter((track) => track.streamable && Boolean(track.trackId));
    room.searchSessions.set(params.userId, { tracks: playable, expiresAt: Date.now() + SEARCH_SESSION_TTL_MS });
    this.touch(room);
    if (!playable.length) {
      return { ok: false, tracks: [], message: 'No matching tracks in the library. Upload music from the Music Library panel.' };
    }
    return { ok: true, tracks: playable, message: `Found ${playable.length} track(s). Select one to add it to the queue.` };
  }

  async pick(params: {
    channelId: string; serverId: string; userId: string; trackId: string;
  }): Promise<{ ok: boolean; message: string; state: PublicMusicState }> {
    const room = this.room(params.channelId, params.serverId);
    const session = room.searchSessions.get(params.userId);
    let track = session?.tracks.find((candidate) => candidate.trackId === params.trackId || candidate.id === params.trackId);
    if (track && session) session.tracks = session.tracks.filter((candidate) => candidate !== track);
    if (!track) track = (await this.deps.library.getPlayableTrack(params.serverId, params.trackId)) || undefined;
    if (!track) return { ok: false, message: 'That search result expired or is no longer available. Search again.', state: this.publicState(room) };
    const result = await this.enqueue(room, [track], params.userId);
    return { ok: result.ok, message: result.message, state: this.publicState(room) };
  }

  async playPlaylist(params: {
    channelId: string; serverId: string; userId: string; playlistId: string;
  }): Promise<{ ok: boolean; message: string; state: PublicMusicState }> {
    const room = this.room(params.channelId, params.serverId);
    if (!this.duplicateGuard(room, params.userId)) {
      return { ok: false, message: 'A music request is already being processed. Try again in a moment.', state: this.publicState(room) };
    }
    const tracks = await this.deps.library.playlistTracks(params.serverId, params.playlistId);
    if (!tracks.length) return { ok: false, message: 'That playlist is empty or does not exist on this server.', state: this.publicState(room) };
    const result = await this.enqueue(room, tracks, params.userId);
    return { ok: result.ok, message: result.message, state: this.publicState(room) };
  }

  pause(params: { channelId: string; serverId: string; userId: string }): { ok: boolean; message: string; state: PublicMusicState } {
    const room = this.rooms.get(params.channelId);
    if (!room?.nowPlaying || room.paused) {
      return { ok: false, message: 'Nothing is currently playing.', state: room ? this.publicState(room) : this.emptyState(params.channelId, params.serverId) };
    }
    room.paused = true;
    room.pausedAt = Date.now();
    this.clearEndTimer(room);
    this.touch(room);
    this.emit(room);
    return { ok: true, message: 'Music paused for everyone.', state: this.publicState(room) };
  }

  async resume(params: { channelId: string; serverId: string; userId: string }): Promise<{ ok: boolean; message: string; state: PublicMusicState }> {
    const room = this.rooms.get(params.channelId);
    if (!room?.nowPlaying || !room.paused) {
      return { ok: false, message: 'Nothing is paused.', state: room ? this.publicState(room) : this.emptyState(params.channelId, params.serverId) };
    }
    const track = room.nowPlaying.track;
    const requesterId = room.nowPlaying.requesterId;
    const offset = this.currentPosition(room);
    await this.startTrack(room, track, requesterId, offset);
    return { ok: true, message: 'Music resumed for everyone.', state: this.publicState(room) };
  }

  async skip(params: { channelId: string; serverId: string; userId: string }): Promise<{ ok: boolean; message: string; state: PublicMusicState }> {
    const room = this.rooms.get(params.channelId);
    if (!room?.nowPlaying) {
      return { ok: false, message: 'Nothing is currently playing.', state: room ? this.publicState(room) : this.emptyState(params.channelId, params.serverId) };
    }
    const skippedTitle = room.nowPlaying.track.title;
    this.clearEndTimer(room);
    room.nowPlaying = null;
    room.paused = false;
    await this.advance(room, params.userId);
    return { ok: true, message: `Skipped "${skippedTitle}".`, state: this.publicState(room) };
  }

  stop(params: { channelId: string; serverId: string; userId: string }): { ok: boolean; message: string; state: PublicMusicState } {
    const room = this.rooms.get(params.channelId);
    if (!room) return { ok: false, message: 'Nothing is playing.', state: this.emptyState(params.channelId, params.serverId) };
    this.clearEndTimer(room);
    room.queue = [];
    room.nowPlaying = null;
    room.paused = false;
    room.pausedAt = 0;
    room.searchSessions.clear();
    room.lastError = null;
    this.touch(room);
    this.emit(room);
    return { ok: true, message: 'Playback stopped and the queue was cleared.', state: this.publicState(room) };
  }

  /** Called by a browser when its media element reaches the end; stale events are ignored. */
  async ended(params: {
    channelId: string; serverId: string; userId: string; trackId: string; playbackId: string;
  }): Promise<{ ok: boolean; message: string; state: PublicMusicState }> {
    const room = this.rooms.get(params.channelId);
    if (!room?.nowPlaying ||
        room.nowPlaying.track.trackId !== params.trackId ||
        room.nowPlaying.playbackId !== params.playbackId ||
        room.paused) {
      return { ok: false, message: 'This playback session has already changed.', state: room ? this.publicState(room) : this.emptyState(params.channelId, params.serverId) };
    }
    // A single browser can report `ended` early (buffering, decoder differences,
    // or a malicious client). Never let that client advance the shared queue
    // before the server-authoritative playback timeline is near the track end.
    const duration = Number(room.nowPlaying.track.duration) || 0;
    if (duration > 0 && this.currentPosition(room) < Math.max(0, duration - 1.5)) {
      return { ok: false, message: 'The shared playback has not reached the end yet.', state: this.publicState(room) };
    }
    this.clearEndTimer(room);
    const endedTitle = room.nowPlaying.track.title;
    room.nowPlaying = null;
    await this.advance(room, params.userId);
    return { ok: true, message: `Finished "${endedTitle}".`, state: this.publicState(room) };
  }

  queue(params: { channelId: string; serverId: string; userId: string }): { ok: boolean; message: string; state: PublicMusicState } {
    const room = this.rooms.get(params.channelId);
    const state = room ? this.publicState(room) : this.emptyState(params.channelId, params.serverId);
    const count = state.queue.length + (state.now_playing ? 1 : 0);
    return { ok: true, message: count ? `${count} track(s) in the shared queue.` : 'The queue is empty.', state };
  }

  nowPlaying(params: { channelId: string; serverId: string; userId: string }): { ok: boolean; message: string; state: PublicMusicState } {
    const room = this.rooms.get(params.channelId);
    const state = room ? this.publicState(room) : this.emptyState(params.channelId, params.serverId);
    return {
      ok: Boolean(state.now_playing),
      message: state.now_playing
        ? `Now playing "${state.now_playing.title}" — ${state.now_playing.artist || 'unknown artist'}.`
        : 'Nothing is playing right now.',
      state
    };
  }
}
