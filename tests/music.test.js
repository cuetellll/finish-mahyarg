/**
 * Mahyar Music — synchronized browser-player tests.
 * These tests verify the browser player, room-scoped state engine, upload
 * fallback wiring, and the absence of the retired LiveKit music worker.
 * Real Railway Bucket + multi-browser audio playback still requires deployment QA.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function createAudioMock() {
  const handlers = new Map();
  const audio = {
    style: {}, readyState: 0, currentTime: 0, duration: 180, paused: true,
    volume: 1, muted: false, src: '', preload: '', autoplay: false,
    controls: false, playsInline: false, tabIndex: 0,
    setAttribute() {},
    removeAttribute(name) { if (name === 'src') this.src = ''; },
    addEventListener(name, fn) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(fn); },
    removeEventListener(name, fn) { handlers.get(name)?.delete(fn); },
    dispatch(name) { for (const fn of [...(handlers.get(name) || [])]) fn({ type: name }); },
    load() { this.readyState = this.src ? 1 : 0; if (this.src) this.dispatch('loadedmetadata'); },
    pause() { this.paused = true; },
    async play() { if (!this.src) throw new Error('no source'); this.paused = false; return true; },
    remove() { this.removed = true; }
  };
  return audio;
}

function loadMusicClient(api = {}) {
  const audio = createAudioMock();
  const storage = new Map();
  const context = {
    window: {},
    document: { createElement: (name) => name === 'audio' ? audio : {}, body: { appendChild() {} } },
    localStorage: { getItem: (key) => storage.has(key) ? storage.get(key) : null, setItem: (key, value) => storage.set(key, String(value)) },
    console,
    setInterval: () => ({ unref() {} }),
    clearInterval() {},
    setTimeout,
    clearTimeout,
    Date,
    Map,
    Set,
    Promise,
    Math,
    Number,
    String,
    Boolean
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/music.js'), 'utf8'), context, { filename: 'js/music.js' });
  const music = new context.window.MahyarMusic({
    musicCommand: async () => ({ ok: true }),
    musicPlaybackUrl: async () => ({ url: 'https://bucket.example.test/song.mp3?sig=test' }),
    ...api
  });
  return { music, audio, storage };
}

const { MusicEngine } = require('../dist/server/music/engine.js');
const library = require('../dist/server/music/library.js');

function libTrack(id, title, extra = {}) {
  return {
    id: `lib:${id}`, origin: 'library', trackId: id, title, artist: 'Tester',
    duration: 120, streamable: true, storageKey: `music/s1/${id}.mp3`, ...extra
  };
}

function makeEngine(libraryTracks, options = {}) {
  const emitted = [];
  const io = {
    to: (room) => ({ emit: (event, state) => emitted.push({ room, event, state }) })
  };
  const libraryResolver = {
    async searchTracks(_serverId, query, limit) {
      const q = query.toLowerCase();
      return libraryTracks.filter((t) => `${t.title} ${t.artist}`.toLowerCase().includes(q)).slice(0, limit);
    },
    async getPlayableTrack(_serverId, trackId) { return libraryTracks.find((t) => t.trackId === trackId) || null; },
    async playlistTracks(_serverId, playlistId) { return playlistId === 'pl_1' ? libraryTracks.slice(0, 2) : []; },
    recordPlay(trackId) { (options.recorded || (options.recorded = [])).push(trackId); }
  };
  const engine = new MusicEngine({ io, library: libraryResolver });
  return { engine, emitted, options };
}

// ---------------------------------------------------------------------------
// Command parser and synchronized browser player
// ---------------------------------------------------------------------------
test('music client parses the small Discord-style /mp command set', () => {
  const { music } = loadMusicClient();
  assert.equal(music.parse('hello world').command, null);
  assert.equal(music.parse('/other play x').command, null);
  assert.equal(music.parse('/mp').command, 'help');
  assert.equal(music.parse('/mp nonsense').command, 'unknown');
  const play = music.parse('/mp play believer imagine dragons');
  assert.equal(play.command, 'play');
  assert.equal(play.args, 'believer imagine dragons');
  assert.equal(music.parse('/mp   play   song  ').args, 'song');
  assert.equal(music.parse('/mp pause').command, 'pause');
  assert.equal(music.parse('/mp nowplaying').command, 'nowplaying');
});

test('music client extracts /mp play autocomplete queries', () => {
  const { music } = loadMusicClient();
  assert.equal(music.playSearchTerm('/mp play Believer'), 'Believer');
  assert.equal(music.playSearchTerm('  /MP  PLAY   my favorite song '), 'my favorite song');
  assert.equal(music.playSearchTerm('/mp play'), null);
  assert.equal(music.playSearchTerm('/mp pause'), null);
});

test('player identity is a UI context, not a LiveKit participant', () => {
  const { music } = loadMusicClient();
  assert.equal(music.constructor.isPlayerIdentity('mahyar-music-player:room123'), true);
  assert.equal(music.constructor.isPlayerIdentity('user_someone'), false);
  assert.equal(music.constructor.isPlayerIdentity(''), false);
});

test('personal volume and mute affect only the local audio element', () => {
  const { music, audio, storage } = loadMusicClient();
  music.setVolume(35);
  assert.equal(audio.volume, 0.35);
  assert.equal(storage.get('mahyar_music_local_volume'), '35');
  music.toggleMute();
  assert.equal(audio.muted, true);
  assert.equal(music.isMuted(), true);
  music.toggleMute();
  assert.equal(audio.muted, false);
  music.setDeafened(true);
  assert.equal(audio.muted, true);
  music.setDeafened(false);
  assert.equal(audio.muted, false);
  music.destroy();
  assert.equal(audio.removed, true);
});

test('switching Voice rooms stops and releases the previous browser audio source', () => {
  const { music, audio } = loadMusicClient();
  music.setActiveChannel('voice-a');
  audio.src = 'https://bucket.example.test/a.mp3';
  audio.paused = false;
  music.setActiveChannel('voice-b');
  assert.equal(audio.paused, true);
  assert.equal(audio.src, '');
  assert.equal(music.activeChannelId, 'voice-b');
  music.destroy();
});

test('browser player loads a signed media URL and starts the synchronized timeline', async () => {
  const calls = [];
  const { music, audio } = loadMusicClient({
    async musicPlaybackUrl(channelId, trackId) { calls.push({ channelId, trackId }); return { url: 'https://bucket.example.test/track.mp3?signature=temporary' }; }
  });
  music.setActiveChannel('voice-1');
  music.handleState({
    channel_id: 'voice-1', server_id: 'srv-1', player_mode: 'synchronized-browser',
    now_playing: { id: 'lib:t1', track_id: 't1', playback_id: 'pb-1', title: 'Believer', artist: 'Imagine Dragons', duration: 180, position: 12, position_ts: Date.now(), started_at: Date.now(), paused: false },
    queue: [], last_error: null
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{ channelId: 'voice-1', trackId: 't1' }]);
  assert.match(audio.src, /track\.mp3/);
  assert.equal(audio.paused, false);
  assert.ok(audio.currentTime >= 11.5 && audio.currentTime <= 13);
  music.destroy();
});

test('player shows a local gesture requirement when browser autoplay is blocked', async () => {
  const audio = createAudioMock();
  audio.play = async () => { const error = new Error('gesture required'); error.name = 'NotAllowedError'; throw error; };
  const storage = new Map();
  const context = {
    window: {}, document: { createElement: () => audio, body: { appendChild() {} } },
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    console, setInterval: () => 1, clearInterval() {}, setTimeout, clearTimeout, Date, Map, Set, Promise, Math, Number, String, Boolean
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/music.js'), 'utf8'), context);
  const music = new context.window.MahyarMusic({ musicPlaybackUrl: async () => ({ url: 'https://bucket.test/a.mp3' }), musicCommand: async () => ({ ok: true }) });
  music.setActiveChannel('voice-1');
  music.handleState({ channel_id: 'voice-1', now_playing: { track_id: 't1', playback_id: 'pb1', position: 0, position_ts: Date.now(), duration: 60, paused: false }, queue: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(music.needsGesture, true);
  music.destroy();
});

// ---------------------------------------------------------------------------
// Shared server timeline and queue
// ---------------------------------------------------------------------------
test('engine starts a shared browser playback state and emits only to the voice music room', async () => {
  const { engine, emitted, options } = makeEngine([libTrack('t1', 'Believer')]);
  const result = await engine.play({ channelId: 'chan1', serverId: 's1', userId: 'u1', query: 'Believer' });
  assert.equal(result.ok, true);
  assert.equal(result.state.now_playing.title, 'Believer');
  assert.equal(result.state.player_mode, 'synchronized-browser');
  assert.equal(result.state.bot_connected, false);
  assert.equal(result.state.bot_identity, null);
  assert.deepEqual(options.recorded, ['t1']);
  assert.ok(emitted.some((entry) => entry.room === 'music:chan1' && entry.event === 'music:state'));
  await engine.shutdown();
});

test('engine reports missing tracks and rejects external URLs', async () => {
  const { engine } = makeEngine([]);
  const url = await engine.play({ channelId: 'chan1', serverId: 's1', userId: 'u1', query: 'https://example.com/a.mp3' });
  assert.equal(url.ok, false);
  assert.match(url.message, /External music links are not supported/i);
  const missing = await engine.play({ channelId: 'chan1', serverId: 's1', userId: 'u2', query: 'nothing' });
  assert.equal(missing.ok, false);
  assert.match(missing.message, /No track matching|Upload/i);
  await engine.shutdown();
});

test('multiple matches open a picker and selected track enters the shared queue', async () => {
  const { engine } = makeEngine([libTrack('t1', 'Believer'), libTrack('t2', 'Believer Live')]);
  const result = await engine.play({ channelId: 'chan1', serverId: 's1', userId: 'u1', query: 'Believer' });
  assert.equal(result.message, 'PICK_RESULT');
  const picked = await engine.pick({ channelId: 'chan1', serverId: 's1', userId: 'u1', trackId: 't2' });
  assert.equal(picked.ok, true);
  assert.equal(picked.state.now_playing.title, 'Believer Live');
  await engine.shutdown();
});

test('one browser cannot end shared playback before the server timeline reaches the track end', async () => {
  const { engine } = makeEngine([libTrack('t1', 'Believer', { duration: 120 }), libTrack('t2', 'Thunder')]);
  await engine.play({ channelId: 'chan1', serverId: 's1', userId: 'u1', query: 'Believer' });
  const current = engine.state('chan1', 's1').now_playing;
  const early = await engine.ended({ channelId: 'chan1', serverId: 's1', userId: 'u2', trackId: 't1', playbackId: current.playback_id });
  assert.equal(early.ok, false);
  assert.equal(early.state.now_playing.title, 'Believer');
  await engine.shutdown();
});

test('pause, resume, skip and stop update the shared timeline', async () => {
  const { engine } = makeEngine([libTrack('t1', 'Believer'), libTrack('t2', 'Thunder')]);
  await engine.play({ channelId: 'chan1', serverId: 's1', userId: 'u1', query: 'Believer' });
  await engine.play({ channelId: 'chan1', serverId: 's1', userId: 'u2', query: 'Thunder' });
  const paused = engine.pause({ channelId: 'chan1', serverId: 's1', userId: 'u1' });
  assert.equal(paused.ok, true);
  assert.equal(paused.state.now_playing.paused, true);
  const resumed = await engine.resume({ channelId: 'chan1', serverId: 's1', userId: 'u1' });
  assert.equal(resumed.ok, true);
  assert.notEqual(resumed.state.now_playing.playback_id, paused.state.now_playing.playback_id);
  const skipped = await engine.skip({ channelId: 'chan1', serverId: 's1', userId: 'u1' });
  assert.equal(skipped.ok, true);
  assert.equal(skipped.state.now_playing.title, 'Thunder');
  const stopped = engine.stop({ channelId: 'chan1', serverId: 's1', userId: 'u1' });
  assert.equal(stopped.state.now_playing, null);
  assert.equal(stopped.state.queue.length, 0);
  await engine.shutdown();
});

test('stale browser ended events cannot advance a newer playback session', async () => {
  const { engine } = makeEngine([libTrack('t1', 'First'), libTrack('t2', 'Second')]);
  const first = await engine.play({ channelId: 'chan1', serverId: 's1', userId: 'u1', query: 'First' });
  await engine.play({ channelId: 'chan1', serverId: 's1', userId: 'u2', query: 'Second' });
  const stale = await engine.ended({ channelId: 'chan1', serverId: 's1', userId: 'u1', trackId: 't1', playbackId: first.state.now_playing.playback_id });
  assert.equal(stale.ok, false);
  assert.equal(stale.state.now_playing.title, 'First');
  await engine.shutdown();
});

test('playlist tracks are queued in order and empty playlists are rejected', async () => {
  const { engine } = makeEngine([libTrack('t1', 'Song A'), libTrack('t2', 'Song B')]);
  const result = await engine.playPlaylist({ channelId: 'chan1', serverId: 's1', userId: 'u1', playlistId: 'pl_1' });
  assert.equal(result.ok, true);
  assert.equal(result.state.now_playing.title, 'Song A');
  assert.equal(result.state.queue[0].title, 'Song B');
  const empty = await engine.playPlaylist({ channelId: 'chan1', serverId: 's1', userId: 'u1', playlistId: 'missing' });
  assert.equal(empty.ok, false);
  await engine.shutdown();
});

test('state returns an empty synchronized-player snapshot for a newly joined room', async () => {
  const { engine } = makeEngine([]);
  const state = engine.state('voice-1', 'server-1');
  assert.equal(state.player_mode, 'synchronized-browser');
  assert.equal(state.channel_id, 'voice-1');
  assert.equal(state.server_id, 'server-1');
  assert.equal(state.now_playing, null);
  await engine.shutdown();
});

// ---------------------------------------------------------------------------
// Library content validation
// ---------------------------------------------------------------------------
test('audio signature sniffing checks actual content rather than filename extension', () => {
  const sniff = library.sniffAudioFormat;
  assert.equal(sniff(Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00.....')), 'mp3');
  assert.equal(sniff(Buffer.from([0xff, 0xfb, 0x90, 0x00])), 'mp3');
  assert.equal(sniff(Buffer.from([0xff, 0xf1, 0x50, 0x80])), 'aac');
  assert.equal(sniff(Buffer.from('OggS\x00\x02xxxxxxxx')), 'ogg');
  assert.equal(sniff(Buffer.from('OggS\x00\x02OpusHeadxxxxxxxx')), 'opus');
  assert.equal(sniff(Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ')), 'wav');
  assert.equal(sniff(Buffer.from('fLaC\x00\x00\x00\x22xxxxxxxx')), 'flac');
  assert.equal(sniff(Buffer.from('\x00\x00\x00\x20ftypM4A \x00\x00\x00\x00')), 'm4a');
  assert.equal(sniff(Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04')), null);
  assert.equal(sniff(Buffer.from('hello world')), null);
});

test('filename metadata is readable and recognizes Artist - Title', () => {
  assert.deepEqual(library.metadataFromFilename('Imagine Dragons - Believer.mp3'), { artist: 'Imagine Dragons', title: 'Believer' });
  assert.equal(library.metadataFromFilename('my_favorite_song.ogg').title, 'my favorite song');
});

// ---------------------------------------------------------------------------
// System wiring and migration guardrails
// ---------------------------------------------------------------------------
test('music system uses synchronized browser playback and has no active server audio worker', () => {
  const backend = fs.readFileSync(path.join(__dirname, '../server/index.ts'), 'utf8');
  const register = fs.readFileSync(path.join(__dirname, '../server/music/register.ts'), 'utf8');
  const engineSource = fs.readFileSync(path.join(__dirname, '../server/music/engine.ts'), 'utf8');
  const librarySource = fs.readFileSync(path.join(__dirname, '../server/music/library.ts'), 'utf8');
  const storage = fs.readFileSync(path.join(__dirname, '../server/music/storage.ts'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
  const api = fs.readFileSync(path.join(__dirname, '../js/api.js'), 'utf8');
  const landingFa = fs.readFileSync(path.join(__dirname, '../public/landing/fa.html'), 'utf8');
  const landingEn = fs.readFileSync(path.join(__dirname, '../public/landing/en.html'), 'utf8');
  const music = fs.readFileSync(path.join(__dirname, '../js/music.js'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  assert.match(backend, /registerMusicSystem/);
  assert.match(backend, /app\.get\('\/fa'/);
  assert.match(backend, /app\.get\('\/en'/);
  assert.match(register, /music:command/);
  assert.match(register, /music:subscribe/);
  assert.match(register, /music:\$\{channelId\}/);
  assert.match(register, /api\/music\/playback-url/);
  assert.match(register, /presignDownload/);
  assert.match(engineSource, /player_mode: 'synchronized-browser'/);
  assert.match(engineSource, /music:\$\{room\.channelId\}/);
  assert.match(music, /document\.createElement\('audio'\)/);
  assert.match(music, /musicPlaybackUrl/);
  assert.match(music, /enableAudio/);
  assert.match(music, /client_received_at/);
  assert.match(api, /musicUploadStream/);
  assert.match(librarySource, /api\/music\/upload\/stream/);
  assert.match(librarySource, /X-Upload-Token|x-upload-token/);
  assert.match(librarySource, /putObjectStream/);
  assert.match(storage, /presignDownload/);
  assert.doesNotMatch(pkg.dependencies, /@livekit\/rtc-node/);
  assert.equal(fs.existsSync(path.join(__dirname, '../server/music/worker-main.ts')), false);
  assert.equal(fs.existsSync(path.join(__dirname, '../server/music/bot.ts')), false);
  assert.match(app, /refreshMessageViewport/);
  assert.match(app, /music-player-member/);
  assert.match(app, /musicEnableAudio/);
  assert.match(app, /browser_uploads_possible === false/);
  assert.doesNotMatch(landingFa + landingEn, /joins the LiveKit voice room as a real participant|به عنوان یک شرکت‌کننده واقعی به اتاق صوتی LiveKit می‌پیوندد|A bot participant named/);
  assert.doesNotMatch(app, /bucket_cors\.js --apply/);
});

test('README files are Persian-first and English-linked, with synchronized-player docs', () => {
  const fa = fs.readFileSync(path.join(__dirname, '../README.md'), 'utf8');
  const en = fs.readFileSync(path.join(__dirname, '../README.en.md'), 'utf8');
  assert.match(fa, /\[🇬🇧 English\]\(README\.en\.md\)/);
  assert.match(en, /\[🇮🇷 فارسی\]\(README\.md\)/);
  assert.match(fa, /پخش هماهنگ/);
  assert.match(en, /synchronized playback/i);
  assert.doesNotMatch(fa + en, /Cloudflare R2|Supabase Storage|Cloudflare D1|FFmpeg → PCM/i);
});
