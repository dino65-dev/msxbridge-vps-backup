import { config } from './config.js';
import { sha256 } from './security.js';
import type { ContentItem, NormalizedSource, ProviderCatalogPage, ProviderDetails, SubtitleCandidate } from './types.js';

type WireItem = {
  ref: string;
  title: string;
  kind: 'movie' | 'series' | 'episode';
  overview?: string;
  year?: number;
  season?: number;
  episode?: number;
  durationSeconds?: number;
  posterUrl?: string;
  backdropUrl?: string;
  logoUrl?: string;
  tags?: string[];
  rating?: number;
};

type WireLink = Omit<NormalizedSource, 'sourceId' | 'provider' | 'subtitles'> & { id: string; subtitles?: SubtitleCandidate[] };

function providerItem(provider: string, item: WireItem): ContentItem {
  return {
    id: `cs_${sha256(`${provider}:${item.ref}`).slice(0, 24)}`,
    provider,
    providerRef: item.ref,
    kind: item.kind,
    title: item.title.slice(0, 240),
    overview: (item.overview ?? '').slice(0, 4000),
    year: item.year,
    season: item.season,
    episode: item.episode,
    durationSeconds: item.durationSeconds,
    posterUrl: item.posterUrl,
    backdropUrl: item.backdropUrl,
    logoUrl: item.logoUrl,
    tags: item.tags?.slice(0, 12),
    rating: item.rating
  };
}

async function request<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${config.compatWorkerUrl}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000)
  });
  const payload = await response.json().catch(() => ({ error: 'invalid_cloudstream_response' })) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : `CloudStream request failed (${response.status})`);
  return payload as T;
}

export class CloudStreamProvider {
  readonly providerId = config.cloudstreamProviderId;

  async health(): Promise<Record<string, unknown>> { return request<Record<string, unknown>>('/v1/health'); }

  async catalog(page = 1): Promise<ProviderCatalogPage[]> {
    const payload = await request<{ provider?: string; pages?: Array<{ title?: string; items?: WireItem[]; hasNext?: boolean }> }>('/v1/catalog', { providerId: this.providerId, page });
    return (payload.pages ?? []).map((entry) => ({
      title: (entry.title ?? 'Featured').slice(0, 80),
      items: (entry.items ?? []).map((item) => providerItem(this.providerId, item)),
      hasNext: entry.hasNext === true
    }));
  }

  async search(query: string, page = 1): Promise<ProviderCatalogPage> {
    const payload = await request<{ provider?: string; items?: WireItem[]; hasNext?: boolean }>('/v1/search', { providerId: this.providerId, query: query.slice(0, 120), page });
    return { title: `Search: ${query}`, items: (payload.items ?? []).map((item) => providerItem(this.providerId, item)), hasNext: payload.hasNext === true };
  }

  async details(item: ContentItem): Promise<ProviderDetails> {
    if (!item.providerRef) throw new Error('content has no provider reference');
    const payload = await request<{ provider?: string; item?: WireItem; episodes?: WireItem[]; seasons?: number[] }>('/v1/details', { providerId: this.providerId, ref: item.providerRef });
    if (!payload.item) throw new Error('provider did not return details');
    const details = providerItem(this.providerId, payload.item);
    return { ...details, seasons: payload.seasons ?? [], episodes: (payload.episodes ?? []).map((episode) => providerItem(this.providerId, episode)) };
  }

  async links(item: ContentItem): Promise<NormalizedSource[]> {
    if (!item.providerRef) throw new Error('content has no provider reference');
    const payload = await request<{ provider?: string; links?: WireLink[] }>('/v1/links', { providerId: this.providerId, ref: item.providerRef });
    const provider = payload.provider ?? this.providerId;
    return (payload.links ?? []).map((link, index) => ({
      sourceId: `cloudstream:${provider}:${link.id || index}`,
      provider,
      url: link.url,
      protocol: link.protocol,
      container: link.container,
      videoCodec: link.videoCodec,
      audioCodec: link.audioCodec,
      height: link.height,
      fps: link.fps,
      bitrate: link.bitrate,
      headers: link.headers,
      expiresAt: link.expiresAt,
      subtitles: link.subtitles
    }));
  }
}
