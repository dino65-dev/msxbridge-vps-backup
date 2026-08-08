import { randomToken } from './security.js';
import { ffprobeMedia, applyProbe, planSamsung2017Playback } from './playback.js';
import { rankSources } from './ranker.js';
import type { DeviceProfile, NormalizedSource, ResolveJob } from './types.js';

export function deduplicateSources(sources: NormalizedSource[]): NormalizedSource[] {
  const seen = new Map<string, NormalizedSource>();
  for (const source of sources) {
    let key = source.url;
    try { const url = new URL(source.url); key = `${url.protocol}//${url.host}${url.pathname}`; } catch { /* validated before playback */ }
    const current = seen.get(key);
    if (!current || (source.height ?? 0) > (current.height ?? 0)) seen.set(key, source);
  }
  return [...seen.values()];
}

export interface SourceResolver {
  id: string;
  resolve(): Promise<NormalizedSource[]>;
}

const probeCache = new Map<string, { expiresAt: number; source: NormalizedSource }>();

async function probe(source: NormalizedSource): Promise<NormalizedSource> {
  const key = `${source.url}:${JSON.stringify(source.headers ?? {})}`;
  const cached = probeCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.source;
  try {
    const updated = applyProbe(source, await ffprobeMedia(source));
    probeCache.set(key, { source: updated, expiresAt: Date.now() + 15 * 60 * 1000 });
    return updated;
  } catch { return source; }
}

export class ResolveJobStore {
  private readonly jobs = new Map<string, ResolveJob>();
  private readonly activeByRequest = new Map<string, string>();

  start(input: { deviceId: string; contentId: string; type: 'movie' | 'series'; profile: DeviceProfile; resolvers: SourceResolver[] }): ResolveJob {
    const requestKey = `${input.deviceId}:${input.type}:${input.contentId}`;
    const activeId = this.activeByRequest.get(requestKey);
    const active = activeId ? this.jobs.get(activeId) : undefined;
    if (active && ['queued', 'resolving', 'playable'].includes(active.state)) return active;
    const now = Date.now();
    const job: ResolveJob = { id: randomToken(12), deviceId: input.deviceId, contentId: input.contentId, type: input.type, state: 'queued', createdAt: now, updatedAt: now, sourcesFound: 0, sources: [], plans: [], providerErrors: [] };
    this.jobs.set(job.id, job); this.activeByRequest.set(requestKey, job.id);
    void this.run(job, input, requestKey);
    return job;
  }

  get(id: string): ResolveJob | undefined { return this.jobs.get(id); }

  private publish(job: ResolveJob, sources: NormalizedSource[], profile: DeviceProfile, state: ResolveJob['state']): void {
    job.sources = rankSources(deduplicateSources(sources), profile);
    job.plans = job.sources.map((source) => planSamsung2017Playback(source, profile));
    job.sourcesFound = job.sources.length;
    job.state = state;
    job.updatedAt = Date.now();
  }

  private async run(job: ResolveJob, input: Parameters<ResolveJobStore['start']>[0], requestKey: string): Promise<void> {
    job.state = 'resolving';
    const sources: NormalizedSource[] = [];
    await Promise.allSettled(input.resolvers.map(async (resolver) => {
      try {
        const discovered = await resolver.resolve();
        sources.push(...discovered);
        const ranked = rankSources(deduplicateSources(sources), input.profile);
        this.publish(job, sources, input.profile, ranked.some((item) => item.decision !== 'reject') ? 'playable' : 'resolving');
      } catch (error) {
        job.providerErrors.push({ provider: resolver.id, message: error instanceof Error ? error.message.slice(0, 200) : 'resolver failed' });
        job.updatedAt = Date.now();
      }
    }));
    const unique = deduplicateSources(sources);
    const probed: NormalizedSource[] = [];
    // Two concurrent ffprobe processes avoid starving the one-TV media budget.
    for (let index = 0; index < unique.slice(0, 3).length; index += 2) {
      probed.push(...await Promise.all(unique.slice(index, index + 2).map(probe)));
    }
    this.publish(job, probed.concat(unique.slice(3)), input.profile, probed.length || unique.length ? 'ready' : 'failed');
    this.activeByRequest.delete(requestKey);
  }
}
