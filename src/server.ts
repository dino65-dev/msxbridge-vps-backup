import { createReadStream, mkdirSync } from 'node:fs';
import Fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { AdaptationManager } from './adapt.js';
import { catalog, getContent } from './catalog.js';
import { CloudStreamProvider } from './cloudstream.js';
import { Store, safeDefaultProfile } from './db.js';
import { proxyMedia } from './media.js';
import { autoPlayPage, catalogPage, detailsPage, diagnosticsPage, homePage, menuObject, resolvingPage, searchPage, settingsPage, sourcesPage, startObject } from './msx.js';
import { planSamsung2017Playback } from './playback.js';
import { rankSources } from './ranker.js';
import { ResolveJobStore, type SourceResolver } from './resolve.js';
import { assertSafeUpstreamUrl, randomToken, sign, verifySignature } from './security.js';
import { fetchManifest, resolveStreams } from './stremio.js';
import { fetchSubtitleSrt } from './subtitles.js';
import type { ContentItem, DeviceProfile, NormalizedSource, PlaybackPlan, ProviderCatalogPage, SubtitleCandidate, SubtitleMode } from './types.js';

mkdirSync(config.dataDir, { recursive: true });
const store = new Store(config.dataDir);
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
const resolveJobs = new ResolveJobStore();
const adaptation = new AdaptationManager(config.dataDir);
const cloudstream = new CloudStreamProvider();
const defaultDevice = store.ensureDevice('samsung-default', config.defaultDeviceName, config.defaultDeviceToken, safeDefaultProfile);
const fallbackPosterPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+uF0AAAAASUVORK5CYII=', 'base64');

function publicUrl(path: string): string { return `${config.publicBaseUrl}${path}`; }
function deviceRoute(token: string): (suffix: string) => string { return (suffix) => publicUrl(`/d/${encodeURIComponent(token)}${suffix}`); }
function requireAdmin(key: unknown): boolean { return typeof key === 'string' && key === config.adminApiKey; }
function fetchHeaders(headers: Record<string, string | string[] | undefined>): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') result.set(key, value);
    else if (Array.isArray(value)) result.set(key, value.join(', '));
  }
  return result;
}

async function compatibilityRequest(path: string, body?: Record<string, unknown>): Promise<{ status: number; payload: unknown }> {
  const response = await fetch(`${config.compatWorkerUrl}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000)
  });
  const text = await response.text();
  let payload: unknown = { error: 'invalid_compatibility_response' };
  try { payload = JSON.parse(text); } catch { if (text) payload = { error: text.slice(0, 500) }; }
  return { status: response.status, payload };
}

function validPluginFileName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(?:cs3|jar)$/.test(value);
}

function pluginInspection(payload: unknown): { sha256: string; fileName: string } | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const value = payload as Record<string, unknown>;
  return typeof value.sha256 === 'string' && /^[0-9a-f]{64}$/.test(value.sha256) && typeof value.fileName === 'string'
    ? { sha256: value.sha256, fileName: value.fileName }
    : undefined;
}

function startResolveJob(device: { id: string; profile: DeviceProfile }, item: ContentItem) {
  const resolvers: SourceResolver[] = [];
  if (item.provider === config.cloudstreamProviderId && item.providerRef) resolvers.push({ id: config.cloudstreamProviderId, resolve: () => cloudstream.links(item) });
  // Stremio remains a second, optional resolver. It is only queried when the
  // provider ref is a real Stremio identifier rather than an opaque website URL.
  if (/^tt\d+$/.test(item.providerRef ?? '')) {
    for (const addon of store.listAddons('stremio').filter((entry) => entry.enabled)) resolvers.push({ id: addon.id, resolve: () => resolveStreams(addon.url, item.kind === 'series' ? 'series' : 'movie', item.providerRef!) });
  }
  if (!resolvers.length) resolvers.push({ id: 'fixtures', resolve: async () => fixtureSources(item.id) });
  return resolveJobs.start({
    deviceId: device.id,
    contentId: item.id,
    type: item.kind === 'series' ? 'series' : 'movie',
    profile: device.profile,
    resolvers
  });
}

function fixtureSources(contentId: string): NormalizedSource[] {
  const shared = { provider: 'msxbridge-fixtures', videoCodec: 'h264' as const, audioCodec: 'aac' as const, height: 720, fps: 24, bitrate: 2_500_000 };
  if (contentId === 'fixture-hls') return [{ ...shared, sourceId: 'fixture-hls', url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8', protocol: 'hls', container: 'mpegts' }];
  if (contentId === 'fixture-calibration') return [{ ...shared, sourceId: 'fixture-calibration', url: 'https://media.w3.org/2010/05/sintel/trailer.mp4', protocol: 'mp4', container: 'mp4' }];
  return [{
    ...shared, sourceId: 'fixture-sintel', url: 'https://media.w3.org/2010/05/sintel/trailer.mp4', protocol: 'mp4', container: 'mp4',
    subtitleUrl: 'https://msx.benzac.de/media/sintel/en.srt',
    subtitles: [{ id: 'fixture-sintel-en', language: 'English', url: 'https://msx.benzac.de/media/sintel/en.srt', format: 'srt' }]
  }];
}

async function resolveConfiguredStremio(contentId: string, profile: DeviceProfile): Promise<ReturnType<typeof rankSources>> {
  const addons = store.listAddons('stremio').filter((addon) => addon.enabled);
  const results = await Promise.allSettled(addons.map((addon) => resolveStreams(addon.url, 'movie', contentId)));
  const sources = results.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
  return rankSources(sources, profile);
}

interface SubtitleSelection {
  candidate: SubtitleCandidate;
  mode: SubtitleMode;
  delayMs: number;
}

function createSession(deviceId: string, contentId: string, source: NormalizedSource, profile: DeviceProfile, selection?: SubtitleSelection): { id: string; signature: string; expiresAt: number } {
  const id = randomToken(18);
  const expiresAt = Date.now() + config.playbackTtlSeconds * 1000;
  store.deleteExpiredSessions();
  const plan: PlaybackPlan = {
    ...planSamsung2017Playback(source, profile),
    subtitle: selection?.candidate,
    subtitleMode: selection?.mode,
    subtitleDelayMs: selection?.delayMs
  };
  store.createPlaybackSession(id, deviceId, contentId, source, expiresAt, plan, selection?.candidate);
  return { id, expiresAt, signature: sign(`${id}.${expiresAt}`, config.tokenHmacSecret) };
}

function adaptationMode(source: NormalizedSource): 'remux' | 'transcode' | undefined {
  const decision = (source as { decision?: unknown }).decision;
  return decision === 'remux' || decision === 'transcode' ? decision : undefined;
}

function playbackSessionUrl(
  session: { id: string; signature: string; expiresAt: number },
  source: NormalizedSource,
  subtitleMode?: SubtitleMode
): string {
  const fileName = subtitleMode === 'burn-in' || adaptationMode(source) || source.protocol === 'hls' ? 'stream.m3u8' : 'stream.mp4';
  return publicUrl(`/play/${session.id}/${session.signature}/${fileName}?expires=${session.expiresAt}`);
}

function subtitleSessionUrl(token: string, session: { id: string; signature: string; expiresAt: number }): string {
  return deviceRoute(token)(`/subtitle/${session.id}/${session.signature}/track.srt?expires=${session.expiresAt}`);
}

function playbackAuthorized(sessionId: string, signature: string, expires: number): { deviceId: string; source: NormalizedSource; expiresAt: number; plan?: PlaybackPlan; subtitle?: SubtitleCandidate } | undefined {
  if (!Number.isSafeInteger(expires) || expires < Date.now() || !verifySignature(`${sessionId}.${expires}`, signature, config.tokenHmacSecret)) return undefined;
  const session = store.getPlaybackSession(sessionId);
  if (!session || session.expiresAt !== expires || session.expiresAt < Date.now()) return undefined;
  return { deviceId: session.deviceId, source: session.source, expiresAt: session.expiresAt, plan: session.plan, subtitle: session.subtitle };
}

function knownContent(id: string): ContentItem | undefined { return store.getContent(id) ?? getContent(id); }

function getAuthorizedDevice(token: string, reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } }) {
  const device = store.getDeviceByToken(token);
  if (!device) { reply.code(404).send({ error: 'unknown_or_revoked_device' }); return undefined; }
  return device;
}

app.addHook('onRequest', async (_request, reply) => {
  reply.header('x-content-type-options', 'nosniff');
  reply.header('referrer-policy', 'no-referrer');
  reply.header('access-control-allow-origin', '*');
  reply.header('access-control-allow-methods', 'GET, HEAD, OPTIONS');
  reply.header('access-control-allow-headers', 'content-type, range');
});

app.get('/healthz', async () => ({ status: 'ok', service: 'msxbridge', now: new Date().toISOString() }));

// The public path is intentionally stable for Media Station X. The secret device
// token appears only in the subsequent home/content URLs generated by this object.
app.get('/start.json', async (_request, reply) => {
  reply.header('cache-control', 'no-store');
  return startObject('MSXBridge', deviceRoute(config.defaultDeviceToken)('/menu.json'));
});

// MSX's TV setup keyboard accepts a hostname, then requests this conventional
// path. Keep the public /msxbridge/start.json URL too for normal browsers.
app.get('/msx/start.json', async (_request, reply) => {
  reply.header('cache-control', 'no-store');
  return startObject('MSXBridge', deviceRoute(config.defaultDeviceToken)('/menu.json'));
});

app.get('/d/:token/start.json', async (request, reply) => {
  const { token } = request.params as { token: string };
  const device = getAuthorizedDevice(token, reply);
  if (!device) return;
  reply.header('cache-control', 'no-store');
  return startObject('MSXBridge', deviceRoute(token)('/menu.json'));
});

app.get('/d/:token/menu.json', async (request, reply) => {
  const { token } = request.params as { token: string };
  if (!getAuthorizedDevice(token, reply)) return;
  reply.header('cache-control', 'no-store');
  return menuObject(deviceRoute(token));
});

app.get('/d/:token/home.json', async (request, reply) => {
  const { token } = request.params as { token: string };
  const device = getAuthorizedDevice(token, reply);
  if (!device) return;
  let pages: ProviderCatalogPage[] = [];
  try {
    pages = await cloudstream.catalog(1);
    for (const page of pages) for (const item of page.items) store.upsertContent(item);
  } catch (error) {
    request.log.warn({ err: error }, 'cloudstream catalog unavailable; serving cached content');
    const cached = store.getRecentContent();
    if (cached.length) pages = [{ title: 'Recently available', items: cached, hasNext: false }];
  }
  const resume = [...store.getRecentContent(), ...catalog].flatMap((item) => {
    const progress = store.getProgress(device.id, item.id);
    return progress && progress.positionSeconds > 10 ? [{ item, positionSeconds: progress.positionSeconds }] : [];
  });
  reply.header('cache-control', 'no-store');
  return homePage(deviceRoute(token), resume, pages);
});

app.get('/d/:token/catalog/:kind.json', async (request, reply) => {
  const { token, kind } = request.params as { token: string; kind: string };
  if (!getAuthorizedDevice(token, reply)) return;
  if (kind !== 'movie' && kind !== 'series') return reply.code(404).send({ error: 'unknown_catalog' });
  const page = Math.max(1, Number((request.query as { page?: string }).page) || 1);
  try {
    const pages = await cloudstream.catalog(page);
    const items = pages.flatMap((entry) => entry.items).filter((item) => item.kind === kind);
    for (const item of items) store.upsertContent(item);
    return catalogPage(kind === 'movie' ? 'Movies' : 'Series', deviceRoute(token), items, page, pages.some((entry) => entry.hasNext));
  } catch (error) {
    request.log.warn({ err: error }, 'catalog request failed');
    const cached = store.getRecentContent().filter((item) => item.kind === kind);
    return catalogPage(kind === 'movie' ? 'Movies' : 'Series', deviceRoute(token), cached, page, false);
  }
});

app.get('/d/:token/search.json', async (request, reply) => {
  const { token } = request.params as { token: string };
  if (!getAuthorizedDevice(token, reply)) return;
  const query = String((request.query as { q?: string }).q ?? '').trim();
  const page = Math.max(1, Number((request.query as { page?: string }).page) || 1);
  if (!query) return searchPage(deviceRoute(token));
  try {
    const result = await cloudstream.search(query, page);
    for (const item of result.items) store.upsertContent(item);
    return searchPage(deviceRoute(token), query, result.items, page, result.hasNext);
  } catch (error) {
    request.log.warn({ err: error }, 'search request failed');
    return { type: 'list', headline: 'Search unavailable', items: [{ title: 'Provider temporarily unavailable', titleFooter: 'Try again shortly.', action: `content:${deviceRoute(token)('/search.json')}` }] };
  }
});

app.get('/d/:token/settings.json', async (request, reply) => {
  const { token } = request.params as { token: string };
  if (!getAuthorizedDevice(token, reply)) return;
  return settingsPage(deviceRoute(token));
});

app.get('/d/:token/diagnostics.srt', async (request, reply) => {
  const { token } = request.params as { token: string };
  if (!getAuthorizedDevice(token, reply)) return;
  reply.type('application/x-subrip; charset=utf-8');
  reply.header('cache-control', 'no-store');
  return `1
00:00:01,000 --> 00:00:05,000
MSXBridge subtitle test: captions are working.

2
00:00:06,000 --> 00:00:10,000
Samsung 2017 AVPlay external SRT test.

3
00:00:11,000 --> 00:00:15,000
Press Back once to return to Diagnostics.
`;
});

app.get('/d/:token/subtitle/:sessionId/:signature/track.srt', async (request, reply) => {
  const { token, sessionId, signature } = request.params as { token: string; sessionId: string; signature: string };
  const device = getAuthorizedDevice(token, reply);
  if (!device) return;
  const expires = Number((request.query as { expires?: string }).expires);
  const authorized = playbackAuthorized(sessionId, signature, expires);
  if (!authorized || authorized.deviceId !== device.id || !authorized.subtitle || authorized.plan?.subtitleMode !== 'soft') {
    return reply.code(403).send({ error: 'invalid_or_expired_subtitle_session' });
  }
  try {
    const srt = await fetchSubtitleSrt(authorized.subtitle);
    const maxAge = Math.max(0, Math.min(300, Math.floor((authorized.expiresAt - Date.now()) / 1000)));
    return reply.type('application/x-subrip; charset=utf-8')
      .header('cache-control', `private, max-age=${maxAge}`)
      .send(srt);
  } catch (error) {
    request.log.warn({ err: error, sessionId }, 'soft subtitle unavailable');
    return reply.code(502).send({ error: 'subtitle_fetch_or_conversion_failed' });
  }
});

const diagnosticSubtitleText = `1
00:00:01,000 --> 00:00:05,000
MSXBridge burned-in subtitle test: captions are working.

2
00:00:06,000 --> 00:00:10,000
This caption is rendered by the VPS, not AVPlay.

3
00:00:11,000 --> 00:00:15,000
This is the reliable Samsung 2017 subtitle fallback.
`;

const diagnosticSubtitleSource: NormalizedSource = {
  sourceId: 'diagnostic-subtitle-burned', provider: 'msxbridge-fixtures',
  url: 'https://media.w3.org/2010/05/sintel/trailer.mp4', protocol: 'mp4', container: 'mp4',
  videoCodec: 'h264', audioCodec: 'aac', height: 720, fps: 24, bitrate: 2_500_000
};

app.get('/d/:token/diagnostics/subtitle-burned.m3u8', async (request, reply) => {
  const { token } = request.params as { token: string };
  if (!getAuthorizedDevice(token, reply)) return;
  const sessionId = `subtitle-burned-${token}`;
  try {
    const playlist = await adaptation.playlist(sessionId, diagnosticSubtitleSource, 'transcode', diagnosticSubtitleText);
    const segmentBase = deviceRoute(token)('/diagnostics/subtitle-burned/segment');
    const rewritten = playlist.split(/\r?\n/).map((line) => line && !line.startsWith('#') ? `${segmentBase}/${encodeURIComponent(line)}` : line).join('\n');
    return reply.header('content-type', 'application/vnd.apple.mpegurl; charset=utf-8').header('cache-control', 'no-store').send(rewritten);
  } catch (error) {
    request.log.warn({ err: error }, 'diagnostic subtitle adaptation unavailable');
    return reply.code(503).send({ error: 'subtitle_adaptation_starting_or_failed' });
  }
});

app.get('/d/:token/diagnostics/subtitle-burned/segment/:fileName', async (request, reply) => {
  const { token, fileName } = request.params as { token: string; fileName: string };
  if (!getAuthorizedDevice(token, reply)) return;
  try {
    const segment = await adaptation.segment(`subtitle-burned-${token}`, fileName);
    return reply.header('content-type', segment.contentType).header('cache-control', 'no-store').send(createReadStream(segment.path));
  } catch {
    return reply.code(404).send({ error: 'subtitle_adaptation_segment_not_found' });
  }
});

app.get('/d/:token/diagnostics.json', async (request, reply) => {
  const { token } = request.params as { token: string };
  if (!getAuthorizedDevice(token, reply)) return;
  reply.header('cache-control', 'no-store');
  return diagnosticsPage(deviceRoute(token));
});

app.get('/d/:token/content/:id.json', async (request, reply) => {
  const { token, id } = request.params as { token: string; id: string };
  const device = getAuthorizedDevice(token, reply);
  if (!device) return;
  let item = knownContent(id);
  if (!item) return reply.code(404).send({ error: 'unknown_content' });
  let episodes: ContentItem[] = [];
  if (item.kind !== 'episode' && item.provider === config.cloudstreamProviderId && item.providerRef) {
    try {
      const details = await cloudstream.details(item);
      item = details;
      store.saveDetails(item, details);
      episodes = details.episodes;
      for (const episode of episodes) store.upsertContent(episode);
    } catch (error) { request.log.warn({ err: error, contentId: id }, 'content details unavailable'); }
  }
  const progress = store.getProgress(device.id, item.id);
  return detailsPage(
    item,
    deviceRoute(token),
    deviceRoute(token)(`/resolve/${encodeURIComponent(item.id)}.json`),
    deviceRoute(token)(`/sources/${encodeURIComponent(item.id)}.json`),
    progress?.positionSeconds,
    episodes
  );
});

app.get('/d/:token/resolve/:id.json', async (request, reply) => {
  const { token, id } = request.params as { token: string; id: string };
  const device = getAuthorizedDevice(token, reply);
  if (!device) return;
  const item = knownContent(id);
  if (!item) return reply.code(404).send({ error: 'unknown_content' });
  const query = request.query as { job?: string };
  const job = query.job ? resolveJobs.get(query.job) : startResolveJob(device, item);
  if (!job || job.deviceId !== device.id) return reply.code(404).send({ error: 'resolve_job_not_found' });
  const deviceUrl = deviceRoute(token);
  // A playable state only means that provider links arrived. Wait for the
  // codec probe so a compatible 720p source is not needlessly transcoded.
  if (job.state !== 'ready' && job.state !== 'failed') return resolvingPage(item, deviceUrl, deviceUrl(`/resolve/${encodeURIComponent(item.id)}.json?job=${encodeURIComponent(job.id)}`), job.sourcesFound);
  const best = job.sources.find((source) => source.decision !== 'reject');
  if (!best) return { type: 'list', headline: `No source • ${item.title}`, items: [{ title: 'No compatible stream', titleFooter: job.providerErrors[0]?.message ?? 'Try again later.', action: `content:${deviceUrl(`/content/${encodeURIComponent(item.id)}.json`)}` }] };
  const session = createSession(device.id, item.id, best, device.profile);
  const playUrl = playbackSessionUrl(session, best);
  return autoPlayPage(item, deviceUrl, playUrl, store.getProgress(device.id, item.id)?.positionSeconds);
});

app.get('/d/:token/sources/:id.json', async (request, reply) => {
  const { token, id } = request.params as { token: string; id: string };
  const device = getAuthorizedDevice(token, reply);
  if (!device) return;
  const item = knownContent(id);
  if (!item) return reply.code(404).send({ error: 'unknown_content' });
  const query = request.query as { job?: string; subtitle?: string; subtitleMode?: string; delayMs?: string };
  const subtitleMode: SubtitleMode = query.subtitleMode === 'burn-in' ? 'burn-in' : 'soft';
  if (query.subtitleMode && query.subtitleMode !== 'soft' && query.subtitleMode !== 'burn-in') return reply.code(400).send({ error: 'invalid_subtitle_mode' });
  const delayMs = Number(query.delayMs ?? 0);
  const allowedDelays = new Set([-2000, -1000, -500, 0, 500, 1000, 2000]);
  if (!Number.isSafeInteger(delayMs) || !allowedDelays.has(delayMs)) return reply.code(400).send({ error: 'invalid_subtitle_delay' });
  const job = query.job ? resolveJobs.get(query.job) : startResolveJob(device, item);
  if (!job || job.deviceId !== device.id) return reply.code(404).send({ error: 'resolve_job_not_found' });
  if (job.state !== 'ready' && job.state !== 'failed') {
    const selected = query.subtitle
      ? `&subtitle=${encodeURIComponent(query.subtitle)}&subtitleMode=${encodeURIComponent(subtitleMode)}&delayMs=${delayMs}`
      : '';
    return resolvingPage(item, deviceRoute(token), deviceRoute(token)(`/sources/${encodeURIComponent(id)}.json?job=${encodeURIComponent(job.id)}${selected}`), job.sourcesFound);
  }
  const subtitle = query.subtitle ? job.sources.flatMap((source) => source.subtitles ?? []).find((candidate) => candidate.id === query.subtitle) : undefined;
  if (query.subtitle && !subtitle) return reply.code(404).send({ error: 'subtitle_not_found' });
  const playUrls = new Map(job.sources.filter((source) => source.decision !== 'reject').map((source) => {
    const selection = subtitle ? { candidate: subtitle, mode: subtitleMode, delayMs } satisfies SubtitleSelection : undefined;
    const session = createSession(device.id, item.id, source, device.profile, selection);
    return [source.sourceId, {
      url: playbackSessionUrl(session, source, selection?.mode),
      subtitleUrl: selection?.mode === 'soft' ? subtitleSessionUrl(token, session) : undefined,
      subtitleDelayMs: selection?.mode === 'soft' ? selection.delayMs : undefined
    }];
  }));
  return sourcesPage(item, deviceRoute(token), job.sources, playUrls, subtitle ? { candidate: subtitle, mode: subtitleMode, delayMs, jobId: job.id } : { jobId: job.id });
});

app.post('/d/:token/action/progress', async (request, reply) => {
  const { token } = request.params as { token: string };
  const device = getAuthorizedDevice(token, reply);
  if (!device) return;
  const body = request.body as { contentId?: unknown; positionSeconds?: unknown; durationSeconds?: unknown } | undefined;
  if (!body || typeof body.contentId !== 'string' || !Number.isFinite(body.positionSeconds) || Number(body.positionSeconds) < 0) {
    return reply.code(400).send({ error: 'invalid_progress_payload' });
  }
  store.saveProgress(device.id, body.contentId, Math.floor(Number(body.positionSeconds)), Number.isFinite(body.durationSeconds) ? Math.floor(Number(body.durationSeconds)) : undefined);
  return { ok: true };
});

app.get('/d/:token/image/:id/:variant', async (request, reply) => {
  const { token, id, variant } = request.params as { token: string; id: string; variant: string };
  if (!getAuthorizedDevice(token, reply)) return;
  const item = knownContent(id);
  const source = variant.includes('backdrop') ? item?.backdropUrl : item?.posterUrl;
  if (source) {
    try {
      const url = await assertSafeUpstreamUrl(source);
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { accept: 'image/jpeg,image/png;q=0.9,*/*;q=0.1' } });
      const length = Number(response.headers.get('content-length') ?? 0);
      const type = response.headers.get('content-type') ?? '';
      const mediaType = type.split(';', 1)[0]?.trim().toLowerCase();
      if (response.ok && (mediaType === 'image/jpeg' || mediaType === 'image/png') && (!length || length <= 2 * 1024 * 1024)) {
        const payload = Buffer.from(await response.arrayBuffer());
        if (payload.length <= 2 * 1024 * 1024) return reply.header('content-type', mediaType).header('cache-control', 'public, max-age=86400, stale-while-revalidate=604800').send(payload);
      }
    } catch (error) { request.log.debug({ err: error, id }, 'image proxy fallback'); }
  }
  reply.header('content-type', 'image/png').header('cache-control', 'public, max-age=86400').send(fallbackPosterPng);
});

async function servePlayback(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const { sessionId, signature, fileName } = request.params as { sessionId: string; signature: string; fileName?: string };
  if (fileName && fileName !== 'stream.m3u8' && fileName !== 'stream.mp4') return reply.code(404).send({ error: 'unknown_playback_resource' });
  const expires = Number((request.query as { expires?: string }).expires);
  const authorized = playbackAuthorized(sessionId, signature, expires);
  if (!authorized) return reply.code(403).send({ error: 'invalid_or_expired_playback_session' });
  const burnSubtitle = authorized.plan?.subtitleMode === 'burn-in' ? authorized.subtitle : undefined;
  const mode = burnSubtitle ? 'transcode' : adaptationMode(authorized.source);
  if (mode) {
    try {
      const subtitleSrt = burnSubtitle ? await fetchSubtitleSrt(burnSubtitle, authorized.plan?.subtitleDelayMs ?? 0) : undefined;
      const playlist = await adaptation.playlist(sessionId, authorized.source, mode, subtitleSrt);
      const segmentBase = publicUrl(`/play/${sessionId}/${signature}/adapt/segment`);
      const rewritten = playlist.split(/\r?\n/).map((line) => line && !line.startsWith('#') ? `${segmentBase}/${encodeURIComponent(line)}?expires=${expires}` : line).join('\n');
      return reply.header('content-type', 'application/vnd.apple.mpegurl; charset=utf-8').header('cache-control', 'no-store').send(rewritten);
    } catch (error) {
      request.log.warn({ err: error, sessionId }, 'adaptation unavailable');
      return reply.code(503).send({ error: 'adaptation_starting_or_failed' });
    }
  }
  return proxyMedia(reply, authorized.source, fetchHeaders(request.headers), undefined, `${publicUrl(`/play/${sessionId}/${signature}/segment`)}?expires=${expires}`);
}

app.get('/play/:sessionId/:signature', servePlayback);
app.get('/play/:sessionId/:signature/:fileName', servePlayback);

app.get('/play/:sessionId/:signature/segment', async (request, reply) => {
  const { sessionId, signature } = request.params as { sessionId: string; signature: string };
  const query = request.query as { expires?: string; url?: string };
  const expires = Number(query.expires);
  if (!query.url || !playbackAuthorized(sessionId, signature, expires)) {
    return reply.code(403).send({ error: 'invalid_or_expired_segment_session' });
  }
  const authorized = playbackAuthorized(sessionId, signature, expires);
  if (!authorized) return reply.code(404).send({ error: 'playback_session_not_found' });
  await proxyMedia(reply, authorized.source, fetchHeaders(request.headers), query.url, `${publicUrl(`/play/${sessionId}/${signature}/segment`)}?expires=${expires}`);
});

app.get('/play/:sessionId/:signature/adapt/segment/:fileName', async (request, reply) => {
  const { sessionId, signature, fileName } = request.params as { sessionId: string; signature: string; fileName: string };
  const expires = Number((request.query as { expires?: string }).expires);
  if (!playbackAuthorized(sessionId, signature, expires)) return reply.code(403).send({ error: 'invalid_or_expired_adaptation_session' });
  try {
    const segment = await adaptation.segment(sessionId, fileName);
    return reply.header('content-type', segment.contentType).header('cache-control', 'no-store').send(createReadStream(segment.path));
  } catch {
    return reply.code(404).send({ error: 'adaptation_segment_not_found' });
  }
});

app.get('/admin', async (_request, reply) => {
  reply.type('text/html').send(`<!doctype html><html><head><meta charset="utf-8"><title>MSXBridge Admin</title><style>body{font:16px system-ui;background:#0f172a;color:#e2e8f0;max-width:760px;margin:4rem auto;padding:0 1rem}input,button{font:inherit;padding:.6rem;margin:.2rem}pre{background:#111827;padding:1rem;overflow:auto}</style></head><body><h1>MSXBridge Admin</h1><p>This console must be reached through your private VPN in production.</p><input id="key" placeholder="Admin API key" type="password"><button onclick="devices()">List devices</button><button onclick="createDevice()">Create device</button><pre id="output"></pre><script>const out=document.getElementById('output');async function call(path,opts={}){opts.headers={...(opts.headers||{}),'x-admin-key':document.getElementById('key').value};let r=await fetch(path,opts);out.textContent=JSON.stringify(await r.json(),null,2)}function devices(){call('/admin/devices')}function createDevice(){call('/admin/devices',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Living Room Samsung'})})}</script></body></html>`);
});

app.get('/admin/devices', async (request, reply) => {
  if (!requireAdmin(request.headers['x-admin-key'])) return reply.code(401).send({ error: 'admin_auth_required' });
  return { devices: store.listDevices() };
});

app.get('/admin/addons', async (request, reply) => {
  if (!requireAdmin(request.headers['x-admin-key'])) return reply.code(401).send({ error: 'admin_auth_required' });
  return { addons: store.listAddons() };
});

app.post('/admin/addons/stremio', async (request, reply) => {
  if (!requireAdmin(request.headers['x-admin-key'])) return reply.code(401).send({ error: 'admin_auth_required' });
  const body = request.body as { url?: unknown } | undefined;
  if (!body || typeof body.url !== 'string') return reply.code(400).send({ error: 'url_required' });
  try {
    const manifest = await fetchManifest(body.url);
    const id = randomToken(12);
    store.addAddon(id, 'stremio', body.url);
    return reply.code(201).send({ id, manifest });
  } catch (error) {
    request.log.warn({ err: error }, 'stremio addon validation failed');
    return reply.code(422).send({ error: 'invalid_stremio_addon' });
  }
});

app.post('/admin/addons/:id/enabled', async (request, reply) => {
  if (!requireAdmin(request.headers['x-admin-key'])) return reply.code(401).send({ error: 'admin_auth_required' });
  const body = request.body as { enabled?: unknown } | undefined;
  if (!body || typeof body.enabled !== 'boolean') return reply.code(400).send({ error: 'enabled_boolean_required' });
  store.setAddonEnabled((request.params as { id: string }).id, body.enabled);
  return { ok: true };
});

app.post('/admin/resolve', async (request, reply) => {
  if (!requireAdmin(request.headers['x-admin-key'])) return reply.code(401).send({ error: 'admin_auth_required' });
  const body = request.body as { contentId?: unknown; deviceId?: unknown } | undefined;
  if (!body || typeof body.contentId !== 'string') return reply.code(400).send({ error: 'content_id_required' });
  const device = typeof body.deviceId === 'string' ? store.listDevices().find((candidate) => candidate.id === body.deviceId) : store.listDevices().find((candidate) => !candidate.revokedAt);
  if (!device) return reply.code(404).send({ error: 'active_device_required' });
  const item = knownContent(body.contentId);
  if (!item) return reply.code(404).send({ error: 'known_content_required' });
  const job = startResolveJob(device, item);
  return reply.code(202).send({ jobId: job.id, state: job.state });
});

app.post('/api/resolve', async (request, reply) => {
  if (!requireAdmin(request.headers['x-admin-key'])) return reply.code(401).send({ error: 'admin_auth_required' });
  const body = request.body as { deviceId?: unknown; type?: unknown; tmdbId?: unknown } | undefined;
  if (!body || typeof body.deviceId !== 'string' || (body.type !== 'movie' && body.type !== 'series') || typeof body.tmdbId !== 'string') {
    return reply.code(400).send({ error: 'deviceId_type_tmdbId_required' });
  }
  const device = store.listDevices().find((candidate) => candidate.id === body.deviceId && !candidate.revokedAt);
  if (!device) return reply.code(404).send({ error: 'active_device_required' });
  const item = knownContent(body.tmdbId) ?? { id: body.tmdbId, provider: 'stremio', providerRef: body.tmdbId, kind: body.type, title: body.tmdbId, overview: '' } satisfies ContentItem;
  const job = startResolveJob(device, item);
  return reply.code(202).send({ jobId: job.id, state: job.state, sourcesFound: job.sourcesFound });
});

app.get('/api/resolve/:jobId', async (request, reply) => {
  if (!requireAdmin(request.headers['x-admin-key'])) return reply.code(401).send({ error: 'admin_auth_required' });
  const job = resolveJobs.get((request.params as { jobId: string }).jobId);
  if (!job) return reply.code(404).send({ error: 'resolve_job_not_found' });
  return job;
});

app.get('/admin/cloudstream/health', async (request, reply) => {
  if (!requireAdmin(request.headers['x-admin-key'])) return reply.code(401).send({ error: 'admin_auth_required' });
  try {
    const result = await compatibilityRequest('/v1/health');
    return reply.code(result.status).send(result.payload);
  } catch (error) {
    request.log.warn({ err: error }, 'compatibility sidecar unavailable');
    return reply.code(503).send({ error: 'compatibility_sidecar_unavailable' });
  }
});

app.post('/admin/cloudstream/plugins/inspect', async (request, reply) => {
  if (!requireAdmin(request.headers['x-admin-key'])) return reply.code(401).send({ error: 'admin_auth_required' });
  const fileName = (request.body as { fileName?: unknown } | undefined)?.fileName;
  if (!validPluginFileName(fileName)) return reply.code(400).send({ error: 'valid_plugin_filename_required' });
  try {
    const result = await compatibilityRequest('/v1/plugins/inspect', { fileName });
    const inspection = pluginInspection(result.payload);
    if (inspection && result.status < 300) store.upsertPlugin(inspection.sha256, inspection.fileName, 'INSPECTED');
    return reply.code(result.status).send(result.payload);
  } catch (error) {
    request.log.warn({ err: error }, 'compatibility inspection failed');
    return reply.code(503).send({ error: 'compatibility_sidecar_unavailable' });
  }
});

app.post('/admin/cloudstream/plugins/execute', async (request, reply) => {
  if (!requireAdmin(request.headers['x-admin-key'])) return reply.code(401).send({ error: 'admin_auth_required' });
  const fileName = (request.body as { fileName?: unknown } | undefined)?.fileName;
  if (!validPluginFileName(fileName)) return reply.code(400).send({ error: 'valid_plugin_filename_required' });
  try {
    const result = await compatibilityRequest('/v1/plugins/execute', { fileName });
    const inspection = pluginInspection(result.payload);
    if (inspection) {
      store.upsertPlugin(inspection.sha256, inspection.fileName, 'INSPECTED');
      store.recordPluginExecution(inspection.sha256, result.status < 300, result.status < 300 ? undefined : JSON.stringify(result.payload));
    }
    return reply.code(result.status).send(result.payload);
  } catch (error) {
    request.log.warn({ err: error }, 'compatibility execution failed');
    return reply.code(503).send({ error: 'compatibility_sidecar_unavailable' });
  }
});

app.get('/admin/cloudstream/plugins', async (request, reply) => {
  if (!requireAdmin(request.headers['x-admin-key'])) return reply.code(401).send({ error: 'admin_auth_required' });
  return { plugins: store.listPlugins() };
});

app.post('/admin/cloudstream/plugins/:sha256/trust', async (request, reply) => {
  if (!requireAdmin(request.headers['x-admin-key'])) return reply.code(401).send({ error: 'admin_auth_required' });
  const sha256 = (request.params as { sha256: string }).sha256;
  const state = (request.body as { state?: unknown } | undefined)?.state;
  if (!/^[0-9a-f]{64}$/.test(sha256) || !['AUTHORIZED', 'ENABLED', 'PENDING_REVIEW', 'QUARANTINED'].includes(String(state))) return reply.code(400).send({ error: 'valid_sha256_and_trust_state_required' });
  store.setPluginTrustState(sha256, state as 'AUTHORIZED' | 'ENABLED' | 'PENDING_REVIEW' | 'QUARANTINED');
  return { ok: true };
});

app.post('/admin/cloudstream/fixtures/execute', async (request, reply) => {
  if (!requireAdmin(request.headers['x-admin-key'])) return reply.code(401).send({ error: 'admin_auth_required' });
  try {
    const result = await compatibilityRequest('/v1/fixtures/execute', {});
    return reply.code(result.status).send(result.payload);
  } catch (error) {
    request.log.warn({ err: error }, 'compatibility fixture execution failed');
    return reply.code(503).send({ error: 'compatibility_sidecar_unavailable' });
  }
});

app.post('/admin/devices', async (request, reply) => {
  if (!requireAdmin(request.headers['x-admin-key'])) return reply.code(401).send({ error: 'admin_auth_required' });
  const body = request.body as { name?: unknown; profile?: unknown } | undefined;
  const id = randomToken(12);
  const token = randomToken(32);
  const name = typeof body?.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 80) : config.defaultDeviceName;
  const profile = body?.profile && typeof body.profile === 'object' ? { ...safeDefaultProfile, ...(body.profile as Partial<DeviceProfile>) } : safeDefaultProfile;
  store.createDevice(id, name, token, profile);
  return reply.code(201).send({ id, name, deviceToken: token, startUrl: deviceRoute(token)('/start.json'), profile });
});

app.put('/admin/devices/:id/profile', async (request, reply) => {
  if (!requireAdmin(request.headers['x-admin-key'])) return reply.code(401).send({ error: 'admin_auth_required' });
  const { id } = request.params as { id: string };
  const body = request.body as Partial<DeviceProfile>;
  store.updateProfile(id, { ...safeDefaultProfile, ...body });
  return { ok: true };
});

app.get('/admin/devices/:id/diagnostics', async (request, reply) => {
  if (!requireAdmin(request.headers['x-admin-key'])) return reply.code(401).send({ error: 'admin_auth_required' });
  return { diagnostics: store.listDiagnostics((request.params as { id: string }).id) };
});

app.post('/admin/devices/:id/diagnostics', async (request, reply) => {
  if (!requireAdmin(request.headers['x-admin-key'])) return reply.code(401).send({ error: 'admin_auth_required' });
  const body = request.body as { testKey?: unknown; passed?: unknown; notes?: unknown; observed?: unknown } | undefined;
  if (!body || typeof body.testKey !== 'string' || !body.testKey.trim() || typeof body.passed !== 'boolean') return reply.code(400).send({ error: 'testKey_and_passed_required' });
  store.saveDiagnostic(randomToken(12), (request.params as { id: string }).id, body.testKey.trim().slice(0, 80), body.passed, typeof body.notes === 'string' ? body.notes : undefined, body.observed);
  return reply.code(201).send({ ok: true });
});

app.delete('/admin/devices/:id', async (request, reply) => {
  if (!requireAdmin(request.headers['x-admin-key'])) return reply.code(401).send({ error: 'admin_auth_required' });
  store.revokeDevice((request.params as { id: string }).id);
  return reply.code(204).send();
});

const shutdown = async () => { await app.close(); store.close(); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);

await app.listen({ host: config.host, port: config.port });
