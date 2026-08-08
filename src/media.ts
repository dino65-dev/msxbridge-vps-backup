import { Readable } from 'node:stream';
import type { FastifyReply } from 'fastify';
import type { NormalizedSource } from './types.js';
import { assertSafeUpstreamUrl } from './security.js';

const FORWARDED_HEADERS = ['range', 'if-range'] as const;
const RESPONSE_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'cache-control'] as const;

function hlsContentType(value: string | null): boolean {
  return value?.includes('application/vnd.apple.mpegurl') === true || value?.includes('application/x-mpegurl') === true || value?.includes('audio/mpegurl') === true;
}

function proxyUrl(sessionPath: string, raw: string, base: string): string {
  const resolved = new URL(raw, base).toString();
  return `${sessionPath}${sessionPath.includes('?') ? '&' : '?'}url=${encodeURIComponent(resolved)}`;
}

export function rewriteHlsPlaylist(original: string, playlistUrl: string, sessionPath: string): string {
  return original.split(/\r?\n/).map((line) => {
    if (!line) return line;
    if (!line.startsWith('#')) return proxyUrl(sessionPath, line, playlistUrl);
    // HLS URI attributes are used for keys, initialization maps, alternate
    // audio/subtitles and I-frame variants. They require the same signed proxy.
    return line.replace(/URI=(?:"([^"]+)"|([^,\s]+))/g, (_match, quoted: string | undefined, bare: string | undefined) => {
      const value = quoted ?? bare;
      if (!value) return _match;
      return `URI="${proxyUrl(sessionPath, value, playlistUrl)}"`;
    });
  }).join('\n');
}

async function upstreamFetch(url: string, source: NormalizedSource, requestHeaders: Headers, redirects = 0): Promise<Response> {
  if (redirects > 4) throw new Error('Too many upstream redirects');
  const safeUrl = await assertSafeUpstreamUrl(url);
  const headers = new Headers(source.headers ?? {});
  for (const header of FORWARDED_HEADERS) {
    const value = requestHeaders.get(header);
    if (value) headers.set(header, value);
  }
  const response = await fetch(safeUrl, { headers, redirect: 'manual', signal: AbortSignal.timeout(25_000) });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get('location');
    if (!location) throw new Error('Upstream redirect has no location');
    return upstreamFetch(new URL(location, safeUrl).toString(), source, requestHeaders, redirects + 1);
  }
  return response;
}

export async function proxyMedia(reply: FastifyReply, source: NormalizedSource, requestHeaders: Headers, segmentUrl?: string, sessionPath?: string): Promise<void> {
  const target = segmentUrl ?? source.url;
  const response = await upstreamFetch(target, source, requestHeaders);
  if (!response.ok && response.status !== 206) {
    reply.code(response.status).send({ error: 'upstream_media_error', status: response.status });
    return;
  }

  if (sessionPath && (source.protocol === 'hls' || hlsContentType(response.headers.get('content-type'))) && hlsContentType(response.headers.get('content-type'))) {
    const original = await response.text();
    const rewritten = rewriteHlsPlaylist(original, response.url || target, sessionPath);
    reply.header('content-type', 'application/vnd.apple.mpegurl; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(rewritten);
    return;
  }

  for (const header of RESPONSE_HEADERS) {
    const value = response.headers.get(header);
    if (value) reply.header(header, value);
  }
  reply.code(response.status);
  if (!response.body) { reply.send(); return; }
  await reply.send(Readable.fromWeb(response.body as import('stream/web').ReadableStream));
}
