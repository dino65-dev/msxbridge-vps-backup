import { resolve } from 'node:path';

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value || value.startsWith('replace-with-')) {
    throw new Error(`${name} must be configured`);
  }
  return value;
}

function positiveInt(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export const config = {
  host: process.env.HOST ?? '127.0.0.1',
  port: positiveInt('PORT', 3000),
  publicBaseUrl: required('PUBLIC_BASE_URL', 'http://127.0.0.1:3000').replace(/\/$/, ''),
  dataDir: resolve(process.env.DATA_DIR ?? './data'),
  adminApiKey: required('ADMIN_API_KEY', 'development-admin-key-change-me'),
  tokenHmacSecret: required('TOKEN_HMAC_SECRET', 'development-hmac-secret-change-me'),
  defaultDeviceName: process.env.DEFAULT_DEVICE_NAME ?? 'Living Room Samsung',
  defaultDeviceToken: required('DEFAULT_DEVICE_TOKEN', 'development-default-device-token-change-me'),
  maxPageItems: positiveInt('TV_MAX_PAGE_ITEMS', 18),
  playbackTtlSeconds: positiveInt('PLAYBACK_TTL_SECONDS', 21_600),
  cloudstreamProviderId: process.env.CLOUDSTREAM_PROVIDER_ID ?? 'MovieBoxProvider',
  workerUrl: process.env.WORKER_URL ?? 'http://cloudstream-worker:8081',
  compatWorkerUrl: process.env.COMPAT_WORKER_URL ?? 'http://cloudstream-compat:8082'
} as const;
