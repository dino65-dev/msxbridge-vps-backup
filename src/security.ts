import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function sign(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

export function verifySignature(value: string, signature: string, secret: string): boolean {
  const expected = Buffer.from(sign(value, secret));
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function isPrivateIpv4(value: string): boolean {
  const [a, b] = value.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127);
}

function isPrivateIp(value: string): boolean {
  if (isIP(value) === 4) return isPrivateIpv4(value);
  const lowered = value.toLowerCase();
  return lowered === '::1' || lowered.startsWith('fc') || lowered.startsWith('fd') || lowered.startsWith('fe80:');
}

/** Rejects endpoints that could turn provider/media fetching into SSRF. */
export async function assertSafeUpstreamUrl(input: string): Promise<URL> {
  const url = new URL(input);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only HTTP(S) upstream URLs are allowed');
  if (url.username || url.password) throw new Error('Credential-bearing URLs are not allowed');
  if (url.port && !['80', '443'].includes(url.port)) throw new Error('Non-standard upstream ports are not allowed');
  if (isPrivateIp(url.hostname)) throw new Error('Private upstream address blocked');
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((entry) => isPrivateIp(entry.address))) throw new Error('Private upstream address blocked');
  return url;
}

export function redactUrl(input: string): string {
  try {
    const url = new URL(input);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '[invalid-url]';
  }
}
