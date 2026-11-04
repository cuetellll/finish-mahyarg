/**
 * Mahyar Music — Railway Storage Bucket helpers (the only storage provider).
 *
 * Railway Buckets speak the S3 protocol, so the AWS SDK stays; the configuration
 * is Railway-specific and reads the variables Railway writes on the Bucket's
 * Credentials tab:
 *
 *   AWS_ENDPOINT_URL       bucket endpoint (https://…)
 *   AWS_ACCESS_KEY_ID      bucket access key
 *   AWS_SECRET_ACCESS_KEY  bucket secret key
 *   AWS_S3_BUCKET_NAME     the S3 bucket *identifier* (not the display name)
 *   AWS_DEFAULT_REGION     bucket region
 *   AWS_S3_URL_STYLE       "virtual-hosted" (default) or "path"
 *
 * Nothing here ever hands out permanent public URLs or credentials:
 *  - uploads  : short-lived presigned PUT performed directly by the browser;
 *  - playback : short-lived presigned GET handed to the bot worker only;
 *  - artwork  : streamed through an authenticated Express route.
 *
 * When the variables are missing every helper reports "not configured" so
 * callers can fail honestly instead of pretending.
 */
import { mkdir, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

/** The exact Railway variable names, used by error payloads and the docs. */
export const STORAGE_ENV_VARS = {
  endpoint: 'AWS_ENDPOINT_URL',
  region: 'AWS_DEFAULT_REGION',
  bucket: 'AWS_S3_BUCKET_NAME',
  accessKeyId: 'AWS_ACCESS_KEY_ID',
  secretAccessKey: 'AWS_SECRET_ACCESS_KEY',
  urlStyle: 'AWS_S3_URL_STYLE'
} as const;

export interface StorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Railway Buckets default to virtual-hosted-style addressing. */
  forcePathStyle: boolean;
  ready: boolean;
}

export function storageConfig(): StorageConfig {
  const endpoint = process.env.AWS_ENDPOINT_URL?.trim().replace(/\/$/, '') || '';
  const region = process.env.AWS_DEFAULT_REGION?.trim() || 'auto';
  const bucket = process.env.AWS_S3_BUCKET_NAME?.trim() || '';
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim() || '';
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim() || '';
  // Railway shows the URL style in the Credentials tab. Virtual-hosted is the
  // default; only switch to path-style when the bucket credentials say so.
  const rawStyle = process.env.AWS_S3_URL_STYLE?.trim().toLowerCase() || 'virtual-hosted';
  // Railway hands out a per-bucket endpoint like https://<bucket>.t3.storageapi.dev.
  // Signing that as virtual-hosted would produce <bucket>.<bucket>.t3.storageapi.dev,
  // a host that does not exist, so the presence of the bucket name in the endpoint
  // host is itself proof that path-style addressing is the correct one.
  const endpointHost = (() => { try { return new URL(endpoint).hostname.toLowerCase(); } catch { return ''; } })();
  const bucketNamesEndpoint = Boolean(bucket) && endpointHost.startsWith(`${bucket.toLowerCase()}.`);
  const forcePathStyle = rawStyle.startsWith('path') || bucketNamesEndpoint;
  const ready = Boolean(endpoint && bucket && accessKeyId && secretAccessKey);
  return { endpoint, region, bucket, accessKeyId, secretAccessKey, forcePathStyle, ready };
}

export function missingStorageVariables(): string[] {
  const storage = storageConfig();
  const missing: string[] = [];
  if (!storage.endpoint) missing.push(STORAGE_ENV_VARS.endpoint);
  if (!storage.bucket) missing.push(STORAGE_ENV_VARS.bucket);
  if (!storage.accessKeyId) missing.push(STORAGE_ENV_VARS.accessKeyId);
  if (!storage.secretAccessKey) missing.push(STORAGE_ENV_VARS.secretAccessKey);
  return missing;
}

type S3Client = import('@aws-sdk/client-s3').S3Client;

let cachedClient: { client: S3Client; key: string } | null = null;

async function client(): Promise<S3Client> {
  const config = storageConfig();
  if (!config.ready) throw new Error('Railway Bucket storage is not configured.');
  const cacheKey = [config.endpoint, config.region, config.bucket, config.accessKeyId, String(config.forcePathStyle)].join('|');
  if (cachedClient && cachedClient.key === cacheKey) return cachedClient.client;
  const { S3Client } = await import('@aws-sdk/client-s3');
  const s3 = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // The AWS SDK >=3.729 adds a CRC32 checksum to every PutObject, which for a
    // presigned URL lands in the query string (x-amz-checksum-crc32=AAAAAA==).
    // Browsers cannot satisfy it, so the bucket rejects the PUT with a signature/
    // digest error long before any byte matters. Integrity is still verified
    // server-side after the upload (HEAD size + magic bytes + ffprobe).
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED'
  });
  cachedClient = { client: s3, key: cacheKey };
  return s3;
}

/** Secure random object key; original filenames are never trusted for paths. */
export function musicObjectKey(serverId: string, extension: string): string {
  const safeExt = extension.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
  return `music/${serverId}/${randomUUID()}.${safeExt}`;
}

/** Presigned PUT the browser performs directly against the bucket (15 min TTL). */
export async function presignUpload(key: string, contentType: string, _maxBytes: number): Promise<string> {
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
  const config = storageConfig();
  const s3 = await client();
  return getSignedUrl(s3, new PutObjectCommand({ Bucket: config.bucket, Key: key, ContentType: contentType }), { expiresIn: 900 });
}

/** Presigned GET for the music worker only (default 2 h to outlive long tracks). */
export async function presignDownload(key: string, expiresSeconds = 7200): Promise<string> {
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
  const config = storageConfig();
  const s3 = await client();
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: config.bucket, Key: key }), { expiresIn: Math.max(60, expiresSeconds) });
}

export interface HeadResult {
  exists: boolean;
  size: number;
  contentType: string;
  etag: string;
}

export async function headObject(key: string): Promise<HeadResult | null> {
  const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
  const config = storageConfig();
  const s3 = await client();
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
    return {
      exists: true,
      size: Number(head.ContentLength || 0),
      contentType: String(head.ContentType || ''),
      etag: String(head.ETag || '').replace(/"/g, '')
    };
  } catch (error: any) {
    if (error?.$metadata?.httpStatusCode === 404 || error?.name === 'NotFound' || error?.name === 'NoSuchKey') return null;
    throw error;
  }
}

export async function deleteObject(key: string): Promise<void> {
  const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
  const config = storageConfig();
  const s3 = await client();
  await s3.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key })).catch(() => undefined);
}

/** Streams an object to the Express response without buffering it in memory. */
export async function streamObjectTo(key: string, res: import('express').Response): Promise<boolean> {
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  const config = storageConfig();
  const s3 = await client();
  try {
    const object = await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
    res.setHeader('Content-Type', String(object.ContentType || 'application/octet-stream'));
    if (object.ContentLength) res.setHeader('Content-Length', String(object.ContentLength));
    res.setHeader('Cache-Control', 'private, max-age=3600');
    if (object.Body && typeof (object.Body as any).pipe === 'function') {
      (object.Body as any).pipe(res);
      return true;
    }
    for await (const chunk of object.Body as any) res.write(Buffer.from(chunk));
    res.end();
    return true;
  } catch (error: any) {
    if (error?.$metadata?.httpStatusCode === 404 || error?.name === 'NotFound' || error?.name === 'NoSuchKey') return false;
    throw error;
  }
}

/**
 * Streams a request body straight into the bucket with a known length, so a
 * large attachment never sits in an Express/Node buffer. Used by the attachment
 * upload route; music uploads never pass through this process at all.
 */
export async function putObjectStream(
  key: string,
  contentType: string,
  contentLength: number,
  body: import('stream').Readable
): Promise<void> {
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  const config = storageConfig();
  const s3 = await client();
  await s3.send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    ContentLength: contentLength
  }));
}

/** Part size for the relay upload: S3 requires >=5 MiB per non-final part. */
const RELAY_PART_BYTES = 8 * 1024 * 1024;

export interface StreamUploadResult {
  size: number;
  etag: string;
}

/**
 * Relay upload: streams an incoming request body into the bucket through this
 * process, with bounded memory (one 8 MiB part at a time, concurrency 1) and a
 * hard byte cap.
 *
 * This exists because a browser can only PUT directly when the bucket answers the
 * CORS preflight for the app origin. Railway has no dashboard switch for that, so
 * until a CORS rule is written the bytes take this same-origin path instead. It
 * costs application egress, which is why the direct path is still preferred and
 * used automatically whenever the bucket allows it.
 */
export async function uploadStreamToBucket(
  key: string,
  contentType: string,
  body: import('stream').Readable,
  maxBytes: number
): Promise<StreamUploadResult> {
  const {
    CreateMultipartUploadCommand, UploadPartCommand,
    CompleteMultipartUploadCommand, AbortMultipartUploadCommand
  } = await import('@aws-sdk/client-s3');
  const config = storageConfig();
  const s3 = await client();

  const created = await s3.send(new CreateMultipartUploadCommand({
    Bucket: config.bucket,
    Key: key,
    ContentType: contentType
  }));
  const uploadId = created.UploadId;
  if (!uploadId) throw new Error('The bucket did not start a multipart upload.');

  const parts: { ETag: string; PartNumber: number }[] = [];
  let buffered: Buffer[] = [];
  let bufferedBytes = 0;
  let total = 0;
  let partNumber = 1;

  const flush = async (): Promise<void> => {
    if (bufferedBytes === 0) return;
    const payload = Buffer.concat(buffered, bufferedBytes);
    buffered = [];
    bufferedBytes = 0;
    const out = await s3.send(new UploadPartCommand({
      Bucket: config.bucket,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
      Body: payload,
      ContentLength: payload.length
    }));
    if (!out.ETag) throw new Error('The bucket did not return an ETag for an uploaded part.');
    parts.push({ ETag: out.ETag, PartNumber: partNumber });
    partNumber += 1;
  };

  try {
    for await (const chunk of body as AsyncIterable<Buffer>) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any);
      total += buffer.length;
      if (total > maxBytes) {
        throw Object.assign(new Error('The uploaded file exceeds the size limit.'), { code: 'TOO_LARGE' });
      }
      buffered.push(buffer);
      bufferedBytes += buffer.length;
      if (bufferedBytes >= RELAY_PART_BYTES) await flush();
    }
    await flush();
    if (total === 0) throw Object.assign(new Error('The upload contained no data.'), { code: 'EMPTY' });
    const done = await s3.send(new CompleteMultipartUploadCommand({
      Bucket: config.bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts }
    }));
    return { size: total, etag: String(done.ETag || '').replace(/"/g, '') };
  } catch (error) {
    // Nothing half-written survives: aborting discards every uploaded part.
    await s3.send(new AbortMultipartUploadCommand({ Bucket: config.bucket, Key: key, UploadId: uploadId })).catch(() => undefined);
    throw error;
  }
}

/**
 * Downloads an object to a temp file for server-side verification
 * (signature check + ffprobe). The file is streamed to disk — the audio
 * bytes never sit in a Node Buffer, and the caller deletes it afterwards.
 * Returns the temp path; the caller owns cleanup.
 */
export async function downloadToTempFile(key: string, maxBytes: number): Promise<string> {
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  const config = storageConfig();
  const s3 = await client();
  const object = await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
  const dir = path.join(tmpdir(), 'mahyar-music-verify');
  await mkdir(dir, { recursive: true });
  const tempPath = path.join(dir, `${randomUUID()}.bin`);
  const { createWriteStream } = await import('fs');
  await new Promise<void>((resolve, reject) => {
    const body = object.Body as any;
    if (!body) return reject(new Error('Empty object body'));
    const out = createWriteStream(tempPath);
    let received = 0;
    body.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes) {
        out.destroy();
        reject(new Error('Uploaded object exceeds the configured size limit.'));
      }
    });
    body.pipe(out);
    out.on('finish', () => resolve());
    out.on('error', reject);
    body.on('error', reject);
  });
  return tempPath;
}

/** Uploads a small local file (extracted artwork) into the bucket. */
export async function putLocalFile(key: string, filePath: string, contentType: string): Promise<void> {
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  const { readFile } = await import('fs/promises');
  const config = storageConfig();
  const s3 = await client();
  const body = await readFile(filePath);
  await s3.send(new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: body, ContentType: contentType, ContentLength: body.length }));
}

export async function removeTempFile(filePath: string): Promise<void> {
  await unlink(filePath).catch(() => undefined);
}

// --------------------------------------------------------------- CORS on the bucket
//
// The browser PUTs audio straight into the bucket, so the bucket itself has to
// answer the CORS preflight for the app origin. Railway exposes no dashboard
// toggle for this: the rules can only be read/written over the S3 API
// (GetBucketCORS / PutBucketCORS). Without a matching rule the browser aborts
// the PUT with a bare network error — this is the single most common cause of
// "Upload to storage failed: the network connection was interrupted".

export interface BucketCorsRule {
  allowedOrigins: string[];
  allowedMethods: string[];
  allowedHeaders: string[];
  exposeHeaders: string[];
  maxAgeSeconds?: number;
}

export interface BucketCorsStatus {
  configured: boolean;
  rules: BucketCorsRule[];
  error?: string;
}

/** Reads the bucket's CORS configuration. Never throws. */
export async function getBucketCors(): Promise<BucketCorsStatus> {
  const config = storageConfig();
  if (!config.ready) return { configured: false, rules: [], error: 'Railway Bucket storage is not configured.' };
  const { GetBucketCorsCommand } = await import('@aws-sdk/client-s3');
  const s3 = await client();
  try {
    const out = await s3.send(new GetBucketCorsCommand({ Bucket: config.bucket }));
    const rules: BucketCorsRule[] = (out.CORSRules || []).map((rule) => ({
      allowedOrigins: rule.AllowedOrigins || [],
      allowedMethods: (rule.AllowedMethods || []).map((method: string) => method.toUpperCase()),
      allowedHeaders: rule.AllowedHeaders || [],
      exposeHeaders: rule.ExposeHeaders || [],
      maxAgeSeconds: rule.MaxAgeSeconds
    }));
    return { configured: rules.length > 0, rules };
  } catch (error: any) {
    const status = error?.$metadata?.httpStatusCode;
    // S3 answers 404 / NoSuchCORSConfiguration when the bucket simply has no rules.
    if (status === 404 || error?.name === 'NoSuchCORSConfiguration') return { configured: false, rules: [] };
    return { configured: false, rules: [], error: error?.message || 'The bucket CORS configuration could not be read.' };
  }
}

/** S3 CORS allows at most one `*` per origin pattern; `*` alone matches everything. */
export function corsOriginMatches(pattern: string, origin: string): boolean {
  const rule = pattern.trim().toLowerCase();
  const target = origin.trim().toLowerCase();
  if (!rule || !target) return false;
  if (rule === '*') return true;
  if (!rule.includes('*')) return rule === target;
  const escaped = rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(target);
}

/** True when some rule allows a PUT from this browser origin. */
export function bucketCorsAllowsOrigin(rules: BucketCorsRule[], origin: string): boolean {
  return rules.some((rule) =>
    rule.allowedMethods.includes('PUT') && rule.allowedOrigins.some((pattern) => corsOriginMatches(pattern, origin))
  );
}

/**
 * Replaces the bucket CORS configuration with one rule that enables browser
 * uploads/reads for the given origins. Only `PUT/GET/HEAD` are allowed and
 * `ETag` is exposed, which is all the uploader needs.
 */
export async function applyBucketCors(origins: string[]): Promise<BucketCorsRule[]> {
  const config = storageConfig();
  if (!config.ready) throw new Error('Railway Bucket storage is not configured.');
  const clean = Array.from(new Set(origins.map((origin) => origin.trim().replace(/\/$/, '')).filter(Boolean)));
  if (!clean.length) throw new Error('At least one origin is required.');
  const rule: BucketCorsRule = {
    allowedOrigins: clean,
    allowedMethods: ['PUT', 'GET', 'HEAD'],
    allowedHeaders: ['*'],
    exposeHeaders: ['ETag'],
    maxAgeSeconds: 3000
  };
  const { PutBucketCorsCommand } = await import('@aws-sdk/client-s3');
  const s3 = await client();
  await s3.send(new PutBucketCorsCommand({
    Bucket: config.bucket,
    CORSConfiguration: {
      CORSRules: [{
        AllowedOrigins: rule.allowedOrigins,
        AllowedMethods: rule.allowedMethods,
        AllowedHeaders: rule.allowedHeaders,
        ExposeHeaders: rule.exposeHeaders,
        MaxAgeSeconds: rule.maxAgeSeconds
      }]
    }
  }));
  return [rule];
}
