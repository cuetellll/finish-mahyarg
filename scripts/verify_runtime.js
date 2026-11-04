#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const failures = [];
function check(name, fn) {
  try { const detail = fn(); console.log(`[verify-runtime] PASS ${name}${detail ? ` — ${detail}` : ''}`); }
  catch (error) { failures.push(name); console.error(`[verify-runtime] FAIL ${name} — ${error.message}`); }
}
function command(bin, args) {
  const result = spawnSync(bin, args, { encoding: 'utf8', timeout: 10000 });
  if (result.error || result.status !== 0) throw new Error((result.stderr || result.error?.message || `exit ${result.status}`).trim());
  return (result.stdout || result.stderr || '').split('\n')[0].trim();
}
check('Linux runtime', () => { if (process.platform !== 'linux') throw new Error(`expected Linux, got ${process.platform}`); return `${process.arch} ${process.version}`; });
check('FFmpeg available for metadata validation', () => command('ffmpeg', ['-version']));
check('FFprobe available for audio metadata validation', () => command('ffprobe', ['-version']));
check('compiled application entry exists', () => { const p = path.resolve(__dirname, '..', 'dist', 'server', 'index.js'); if (!fs.existsSync(p)) throw new Error(`missing ${p}`); return p; });
check('compiled synchronized music engine exists', () => { const p = path.resolve(__dirname, '..', 'dist', 'server', 'music', 'engine.js'); if (!fs.existsSync(p)) throw new Error(`missing ${p}`); return p; });
if (failures.length) process.exit(1);
console.log('[verify-runtime] All runtime checks passed.');
