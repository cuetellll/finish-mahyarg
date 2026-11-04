#!/usr/bin/env node
/**
 * Railway Bucket CORS helper.
 *
 * The music uploader writes audio straight into the private bucket with a
 * presigned PUT, so the bucket must answer the browser's CORS preflight for the
 * app's origin. Railway has no dashboard toggle for this — the rules only exist
 * over the S3 API (GetBucketCORS / PutBucketCORS). Until a matching rule exists
 * the browser kills the PUT instantly and the UI can only report
 * "the browser could not reach the bucket".
 *
 * Usage (reads the same variables the server reads):
 *
 *   node --env-file-if-exists=.env scripts/bucket_cors.js --check
 *   node --env-file-if-exists=.env scripts/bucket_cors.js --check --origin https://app.up.railway.app
 *   node --env-file-if-exists=.env scripts/bucket_cors.js --apply https://app.up.railway.app http://localhost:3000
 *
 * On Railway: `railway run node scripts/bucket_cors.js --apply https://<your-domain>`
 *
 * This is an ops tool: it mirrors storageConfig() in server/music/storage.ts
 * instead of importing the compiled TS build, so it runs before `npm run build`.
 * It never prints the access key or the secret key.
 */
'use strict';

const { S3Client, GetBucketCorsCommand, PutBucketCorsCommand } = require('@aws-sdk/client-s3');

const REQUIRED = ['AWS_ENDPOINT_URL', 'AWS_S3_BUCKET_NAME', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'];

function storageConfig() {
  const endpoint = (process.env.AWS_ENDPOINT_URL || '').trim().replace(/\/$/, '');
  const region = (process.env.AWS_DEFAULT_REGION || '').trim() || 'auto';
  const bucket = (process.env.AWS_S3_BUCKET_NAME || '').trim();
  const accessKeyId = (process.env.AWS_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = (process.env.AWS_SECRET_ACCESS_KEY || '').trim();
  const style = (process.env.AWS_S3_URL_STYLE || 'virtual-hosted').trim().toLowerCase();
  return { endpoint, region, bucket, accessKeyId, secretAccessKey, forcePathStyle: style.startsWith('path'), style };
}

function client(config) {
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }
  });
}

/** S3 allows at most one `*` per origin pattern; `*` alone matches everything. */
function originMatches(pattern, origin) {
  const rule = String(pattern || '').trim().toLowerCase();
  const target = String(origin || '').trim().toLowerCase().replace(/\/$/, '');
  if (!rule || !target) return false;
  if (rule === '*') return true;
  if (!rule.includes('*')) return rule.replace(/\/$/, '') === target;
  const escaped = rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(target);
}

function parseArgs(argv) {
  const args = { mode: 'check', origins: [], origin: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') args.mode = 'apply';
    else if (arg === '--check') args.mode = 'check';
    else if (arg === '--origin') args.origin = argv[++i] || null;
    else if (arg === '--help' || arg === '-h') args.mode = 'help';
    else if (arg.startsWith('-')) throw new Error(`Unknown flag: ${arg}`);
    else args.origins.push(arg.trim().replace(/\/$/, ''));
  }
  return args;
}

async function readCors(s3, bucket) {
  try {
    const out = await s3.send(new GetBucketCorsCommand({ Bucket: bucket }));
    return { configured: (out.CORSRules || []).length > 0, rules: out.CORSRules || [] };
  } catch (error) {
    const status = error?.$metadata?.httpStatusCode;
    if (status === 404 || error?.name === 'NoSuchCORSConfiguration') return { configured: false, rules: [] };
    throw error;
  }
}

function describeRules(rules) {
  if (!rules.length) return '  (no CORS rules — browser uploads are blocked)';
  return rules.map((rule, index) => [
    `  rule ${index + 1}:`,
    `    origins : ${(rule.AllowedOrigins || []).join(', ') || '(none)'}`,
    `    methods : ${(rule.AllowedMethods || []).join(', ') || '(none)'}`,
    `    headers : ${(rule.AllowedHeaders || []).join(', ') || '*'}`,
    `    expose  : ${(rule.ExposeHeaders || []).join(', ') || '(none)'}`
  ].join('\n')).join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'help') {
    console.log('Usage:\n  node scripts/bucket_cors.js --check [--origin https://app.example.com]\n  node scripts/bucket_cors.js --apply https://app.example.com [http://localhost:3000]');
    return 0;
  }

  const missing = REQUIRED.filter((name) => !process.env[name]);
  if (missing.length) {
    console.error(`Missing environment variables: ${missing.join(', ')}`);
    console.error('Copy them from the Railway Bucket Credentials tab, or run this through `railway run`.');
    return 2;
  }

  const config = storageConfig();
  const s3 = client(config);
  console.log(`Bucket   : ${config.bucket}`);
  console.log(`Endpoint : ${config.endpoint}`);
  console.log(`URL style: ${config.style} (forcePathStyle=${config.forcePathStyle})`);
  console.log('');

  if (args.mode === 'apply') {
    if (!args.origins.length) {
      console.error('--apply needs at least one origin, e.g. --apply https://app.up.railway.app');
      return 2;
    }
    const rules = [{
      AllowedOrigins: args.origins,
      AllowedMethods: ['PUT', 'GET', 'HEAD'],
      AllowedHeaders: ['*'],
      ExposeHeaders: ['ETag'],
      MaxAgeSeconds: 3000
    }];
    await s3.send(new PutBucketCorsCommand({ Bucket: config.bucket, CORSConfiguration: { CORSRules: rules } }));
    console.log(`CORS applied for: ${args.origins.join(', ')}`);
    const after = await readCors(s3, config.bucket);
    console.log(describeRules(after.rules));
    return after.configured ? 0 : 1;
  }

  const current = await readCors(s3, config.bucket);
  console.log(describeRules(current.rules));
  console.log('');
  const origin = args.origin || args.origins[0] || null;
  if (!origin) {
    console.log('Pass --origin https://your-app to test whether a specific origin may upload.');
    return current.configured ? 0 : 1;
  }
  const allowed = current.rules.some((rule) =>
    (rule.AllowedMethods || []).map((m) => m.toUpperCase()).includes('PUT') &&
    (rule.AllowedOrigins || []).some((pattern) => originMatches(pattern, origin))
  );
  console.log(`Origin   : ${origin}`);
  console.log(`PUT allowed by CORS: ${allowed ? 'YES' : 'NO'}`);
  if (!allowed) {
    console.log('');
    console.log('Fix it with:');
    console.log(`  node --env-file-if-exists=.env scripts/bucket_cors.js --apply ${origin}`);
  }
  return allowed ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`Failed: ${error?.message || error}`);
    if (error?.$metadata?.httpStatusCode) console.error(`HTTP status: ${error.$metadata.httpStatusCode}`);
    process.exit(1);
  });
