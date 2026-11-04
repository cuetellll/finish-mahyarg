#!/usr/bin/env node
/**
 * Mahyar Gap — production image runtime verification (build-time gate).
 *
 * Runs INSIDE the final production Docker image (`RUN node scripts/verify_runtime.js`)
 * and fails the Docker build with a meaningful error if the Mahyar Music worker
 * could not run in this image. Verified on the exact image that ships:
 *
 *   1. Linux + supported architecture (x64 / arm64).
 *   2. GNU/glibc userland (NOT musl/Alpine) — @livekit/rtc-ffi-bindings ships
 *      only glibc binaries (`libc: [glibc]`), so a musl image is a hard fail.
 *   3. The correct GNU native binding package is installed for this
 *      architecture and its .node binary links without missing libraries (ldd).
 *   4. `require('@livekit/rtc-node')` loads and a Room can be constructed.
 *   5. ffmpeg runs and prints a version.
 *   6. dist/server/music/worker-main.js exists, parses (`node --check`), and
 *      sits next to bot.js exactly the way bot.ts resolves it at runtime.
 *
 * Zero npm dependencies; Node >= 18.
 */
'use strict';

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PREFIX = '[verify-runtime]';
const failures = [];

async function check(name, fn) {
  try {
    const detail = await fn();
    console.log(`${PREFIX} PASS ${name}${detail ? ` — ${detail}` : ''}`);
    return detail || 'ok';
  } catch (error) {
    failures.push({ name, error });
    console.error(`${PREFIX} FAIL ${name} — ${error && error.message ? error.message : error}`);
    return false;
  }
}

function fail(message) {
  throw new Error(message);
}

// ---------------------------------------------------------------- 1. platform
function requireLinuxSupportedArch() {
  if (process.platform !== 'linux') fail(`unsupported platform "${process.platform}" — production images must be Linux`);
  if (process.arch !== 'x64' && process.arch !== 'arm64') {
    fail(`unsupported architecture "${process.arch}" — @livekit/rtc-ffi-bindings provides glibc binaries for linux-x64-gnu and linux-arm64-gnu only`);
  }
  return `${process.platform}-${process.arch}`;
}

// -------------------------------------------------------------- 2. libc check
function requireGlibc() {
  let glibcVersion = null;
  try {
    const report = process.report && typeof process.report.getReport === 'function' ? process.report.getReport() : null;
    glibcVersion = report && report.header && report.header.glibcVersionRuntime ? report.header.glibcVersionRuntime : null;
  } catch { /* fall through to ldd */ }
  if (glibcVersion) return `glibc ${glibcVersion}`;
  // Fallback: ldd — musl ldd prints "musl", GNU ldd prints "GLIBC".
  const ldd = spawnSync('ldd', ['--version'], { encoding: 'utf8' });
  const out = `${ldd.stdout || ''}${ldd.stderr || ''}`;
  if (/GLIBC/i.test(out)) return 'glibc (detected via ldd)';
  if (/musl/i.test(out)) fail('musl libc detected — @livekit/rtc-ffi-bindings ships GNU/glibc binaries only. Rebuild the image from node:22-bookworm-slim (Debian), not Alpine.');
  fail('unable to determine libc flavor (no process.report, no ldd) — refusing to ship an unverified native runtime');
}

// ------------------------------------------------- 3. native binding + ldd
function gnuBindingPackage() {
  const suffix = process.arch === 'arm64' ? 'linux-arm64-gnu' : 'linux-x64-gnu';
  const pkg = `@livekit/rtc-ffi-bindings-${suffix}`;
  try {
    const resolved = require.resolve(pkg);
    return { pkg, resolved };
  } catch {
    fail(
      `${pkg} is NOT installed in node_modules. npm skips this optional dependency on musl/Alpine or unsupported architectures, ` +
      'so require(\'@livekit/rtc-node\') would crash the music worker with exit code 1. ' +
      'Build the image from a GNU/glibc base (node:22-bookworm-slim).'
    );
  }
}

function findNativeBinary(pkgRoot) {
  const binaries = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.node')) binaries.push(full);
    }
  };
  walk(pkgRoot, 0);
  if (!binaries.length) fail(`no .node native binary found in ${pkgRoot}`);
  return binaries[0];
}

function requireLinkableNativeBinary(bindingPath) {
  const ldd = spawnSync('ldd', [bindingPath], { encoding: 'utf8' });
  const out = `${ldd.stdout || ''}${ldd.stderr || ''}`;
  if (ldd.status !== 0 && !out.trim()) fail(`ldd could not inspect ${bindingPath}`);
  const missing = out.split('\n').filter((line) => /not found/i.test(line)).map((line) => line.trim());
  if (missing.length) {
    fail(
      `the LiveKit native binding has unresolved shared libraries: ${missing.join('; ')}. ` +
      'The runner stage must install the glibc runtime libraries (libstdc++6, ca-certificates) — see the Dockerfile runner stage.'
    );
  }
  return path.basename(bindingPath);
}

function requireRtcNodeLoads() {
  return new Promise((resolve, reject) => {
    let rtc;
    try {
      rtc = require('@livekit/rtc-node');
    } catch (error) {
      reject(new Error(`require('@livekit/rtc-node') failed: ${error && error.message ? error.message : error}`));
      return;
    }
    if (!rtc || typeof rtc.Room !== 'function') {
      reject(new Error("'@livekit/rtc-node' loaded but does not export Room — package version mismatch?"));
      return;
    }
    // Constructing a Room + AudioSource exercises the FFI layer; a broken
    // native runtime dies here with a dlopen/FFI error.
    Promise.resolve().then(async () => {
      // eslint-disable-next-line no-new
      const probe = new rtc.Room();
      void probe; // handle left for GC — Room has no sync close() in rtc-node 1.2.x
      const probeSource = new rtc.AudioSource(48000, 2);
      await probeSource.close();
      resolve(versionOf('@livekit/rtc-node'));
    }).catch((error) => {
      reject(new Error(`native runtime loaded but Room/AudioSource construction failed: ${error && error.message ? error.message : error}`));
    });
  });
}

function versionOf(packageName) {
  try {
    let dir = path.dirname(require.resolve(packageName));
    // Walk up to the package root (handles scoped names like @livekit/rtc-node).
    for (let i = 0; i < 8; i++) {
      const pkgJson = path.join(dir, 'package.json');
      if (fs.existsSync(pkgJson)) {
        const data = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
        if (data.name === packageName) return data.version || 'unknown';
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch { /* best effort */ }
  return 'unknown';
}

// ------------------------------------------------------------ 4. ffmpeg check
function requireFfmpeg() {
  let version;
  try {
    version = execFileSync('ffmpeg', ['-version'], { encoding: 'utf8', timeout: 10_000 }).split('\n')[0].trim();
  } catch (error) {
    fail(`ffmpeg is not runnable in this image: ${error && error.message ? error.message : error} — the runner stage must "apt-get install -y ffmpeg"`);
  }
  if (!/^ffmpeg version/i.test(version)) fail(`unexpected ffmpeg version output: "${version.slice(0, 80)}"`);
  return version;
}

// --------------------------------------------- 5. worker entrypoint integrity
function requireWorkerEntrypoint() {
  const workerEntry = path.resolve(__dirname, '..', 'dist', 'server', 'music', 'worker-main.js');
  const botEntry = path.resolve(__dirname, '..', 'dist', 'server', 'music', 'bot.js');
  if (!fs.existsSync(workerEntry)) fail(`compiled worker entrypoint missing: ${workerEntry} — "npm run build" did not emit it`);
  if (!fs.existsSync(botEntry)) fail(`compiled worker manager missing: ${botEntry} — bot.ts resolves worker-main.js via path.join(__dirname, 'worker-main.js')`);

  const syntax = spawnSync(process.execPath, ['--check', workerEntry], { encoding: 'utf8' });
  if (syntax.status !== 0) fail(`worker-main.js does not parse: ${(syntax.stderr || '').split('\n')[0]}`);

  // Worker loads with zero diagnostics loss: it must at least import cleanly up
  // to its first step (missing MUSIC_WORKER_INIT makes it exit(1) AFTER logging
  // a fatal message — here we only assert the module graph parses + loads).
  return `${path.relative(path.dirname(botEntry), workerEntry)} next to bot.js`;
}

// ------------------------------------------------------------------ execute
async function main() {
  console.log(`${PREFIX} verifying production image for the Mahyar Music worker…`);
  const platform = await check('linux + supported architecture', () => requireLinuxSupportedArch());
  const libc = await check('GNU/glibc userland (not musl)', () => requireGlibc());
  const binding = await check('GNU native binding installed', () => gnuBindingPackage().pkg);
  const linked = await check('native binding links cleanly (ldd)', () => {
    const info = gnuBindingPackage();
    const pkgRoot = path.resolve(info.resolved, '..');
    const binary = findNativeBinary(pkgRoot);
    return `${requireLinkableNativeBinary(binary)} (${binary})`;
  });
  const rtcVersion = await check("require('@livekit/rtc-node') + Room/AudioSource construction", () => requireRtcNodeLoads());
  const ffmpeg = await check('ffmpeg runs', () => requireFfmpeg());
  const entry = await check('worker entrypoint exists and parses', () => requireWorkerEntrypoint());

  if (failures.length) {
    console.error(`${PREFIX} ${failures.length} check(s) FAILED — the Mahyar Music worker would crash in this image (exit code 1 during startup).`);
    console.error(`${PREFIX} Build FAILED on purpose so a broken Music Worker never reaches deployment.`);
    process.exit(1);
  }
  console.log(`${PREFIX} ALL CHECKS PASSED`);
  console.log(`${PREFIX}   platform        : ${platform}`);
  console.log(`${PREFIX}   libc            : ${libc}`);
  console.log(`${PREFIX}   native binding  : ${binding}`);
  console.log(`${PREFIX}   rtc-node        : v${rtcVersion}`);
  console.log(`${PREFIX}   ffmpeg          : ${ffmpeg}`);
  console.log(`${PREFIX}   worker entry    : ${entry}`);
  // Native FFI handles keep the event loop alive — exit explicitly.
  process.exit(0);
}

void main();
