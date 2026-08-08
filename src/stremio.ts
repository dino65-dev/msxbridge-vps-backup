import { assertSafeUpstreamUrl } from './security.js';
import type { NormalizedSource } from './types.js';

interface StremioManifest {
  id?: string;
  name?: string;
  version?: string;
  resources?: Array<string | { name?: string }>;
}

interface StremioStream {
  name?: string;
  title?: string;
  url?: string;
  externalUrl?: string;
  behaviorHints?: { notWebReady?: boolean };
}

const manifestCache = new Map<string, { expiresAt: number; manifest: StremioManifest }>();

function manifestUrl(input: string): URL {
  const url = new URL(input);
  if (!url.pathname.endsWith('/manifest.json')) url.pathname = `${url.pathname.replace(/\/$/, '')}/manifest.json`;
  return url;
}

function codecFromText(value: string): Pick<NormalizedSource, 'protocol' | 'container' | 'videoCodec' | 'audioCodec' | 'height'> {
  const text = value.toLowerCase();
  const height = /2160|4k/.test(text) ? 2160 : /1080/.test(text) ? 1080 : /720/.test(text) ? 720 : undefined;
  const protocol = /m3u8|hls/.test(text) ? 'hls' : 'mp4';
  return {
    protocol,
    container: protocol === 'hls' ? 'mpegts' : /mkv/.test(text) ? 'mkv' : 'mp4',
    videoCodec: /av1/.test(text) ? 'av1' : /hevc|h265|x265/.test(text) ? 'hevc' : /vp9/.test(text) ? 'vp9' : 'h264',
    audioCodec: /opus/.test(text) ? 'opus' : /eac3|dd\+/.test(text) ? 'eac3' : /ac3|dts/.test(text) ? 'ac3' : 'aac',
    height
  };
}

export async function fetchManifest(addonUrl: string): Promise<StremioManifest> {
  const url = manifestUrl(addonUrl).toString();
  const cached = manifestCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.manifest;
  await assertSafeUpstreamUrl(url);
  const response = await fetch(url, { signal: AbortSignal.timeout(12_000), headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`Stremio manifest request failed with ${response.status}`);
  const manifest = await response.json() as StremioManifest;
  if (!manifest.id || !manifest.name) throw new Error('Invalid Stremio manifest');
  manifestCache.set(url, { manifest, expiresAt: Date.now() + 60 * 60 * 1000 });
  return manifest;
}

export async function resolveStreams(addonUrl: string, type: 'movie' | 'series', stremioId: string): Promise<NormalizedSource[]> {
  const base = manifestUrl(addonUrl);
  const manifest = await fetchManifest(base.toString());
  const supportsStreams = manifest.resources?.some((resource) => resource === 'stream' || (typeof resource === 'object' && resource.name === 'stream'));
  if (!supportsStreams) return [];
  const streamUrl = new URL(`stream/${encodeURIComponent(type)}/${encodeURIComponent(stremioId)}.json`, base);
  await assertSafeUpstreamUrl(streamUrl.toString());
  const response = await fetch(streamUrl, { signal: AbortSignal.timeout(20_000), headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`${manifest.name} stream request failed with ${response.status}`);
  const payload = await response.json() as { streams?: StremioStream[] };
  const sources: NormalizedSource[] = [];
  const provider = manifest.name ?? 'Unknown Stremio addon';
  for (const [index, stream] of (payload.streams ?? []).entries()) {
    const streamUrlValue = stream.url ?? stream.externalUrl;
    // notWebReady means the television must not talk to the provider directly;
    // MSXBridge can still proxy its headers and rewrite HLS safely.
    if (!streamUrlValue) continue;
    try {
      await assertSafeUpstreamUrl(streamUrlValue);
    } catch {
      continue;
    }
    const label = `${stream.name ?? ''} ${stream.title ?? ''} ${streamUrlValue}`;
    sources.push({
      sourceId: `stremio:${manifest.id}:${index}`,
      provider,
      url: streamUrlValue,
      ...codecFromText(label),
      ...(stream.behaviorHints?.notWebReady ? { headers: { 'user-agent': 'MSXBridge/1.0' } } : {})
    });
  }
  return sources;
}
