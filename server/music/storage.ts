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
  const forcePathStyle = rawStyle.startsWith('path');
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
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }
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
