import http from 'node:http';

const PORT = Number.parseInt(process.env.PORT || '8090', 10);
const COMPAT_URL = (process.env.COMPAT_WORKER_URL || 'http://cloudstream-compat:8082').replace(/\/$/, '');
const PROVIDER_ID = process.env.CLOUDSTREAM_PROVIDER_ID || 'MovieBoxProvider';
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const BRIDGE_TOKEN = process.env.NUVIO_MOVIEBOX_BRIDGE_TOKEN || '';
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.REQUEST_TIMEOUT_MS || '20000', 10);

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('request_too_large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function compat(path, body) {
  const response = await fetch(`${COMPAT_URL}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); }
  catch { payload = { error: text.slice(0, 300) || 'invalid_response' }; }
  if (!response.ok) throw new Error(payload?.error || `compat_http_${response.status}`);
  return payload;
}

async function tmdbDetails(tmdbId, mediaType) {
  if (!TMDB_API_KEY) throw new Error('TMDB_API_KEY_missing');
  const kind = mediaType === 'tv' || mediaType === 'series' ? 'tv' : 'movie';
  const url = `https://api.themoviedb.org/3/${kind}/${encodeURIComponent(tmdbId)}?api_key=${encodeURIComponent(TMDB_API_KEY)}&language=en-US`;
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`tmdb_http_${response.status}`);
  const data = await response.json();
  return {
    title: kind === 'tv' ? data.name : data.title,
    year: Number.parseInt(String(kind === 'tv' ? data.first_air_date : data.release_date).slice(0, 4), 10) || undefined,
    kind
  };
}

function normalizeTitle(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function scoreCandidate(item, wanted) {
  const a = normalizeTitle(item?.title);
  const b = normalizeTitle(wanted.title);
  let score = 0;
  if (a === b) score += 100;
  else if (a.includes(b) || b.includes(a)) score += 70;
  else {
    const aw = new Set(a.split(' ').filter(Boolean));
    const bw = new Set(b.split(' ').filter(Boolean));
    const common = [...aw].filter((word) => bw.has(word)).length;
    score += Math.round((common / Math.max(1, Math.max(aw.size, bw.size))) * 60);
  }
  if (wanted.year && item?.year === wanted.year) score += 25;
  if (item?.kind === wanted.kind || (wanted.kind === 'tv' && item?.kind === 'series')) score += 10;
  return score;
}

function qualityLabel(height) {
  if (!height) return 'Unknown';
  if (height >= 2160) return '4K';
  if (height >= 1440) return '1440p';
  if (height >= 1080) return '1080p';
  if (height >= 720) return '720p';
  if (height >= 480) return '480p';
  return `${height}p`;
}

function pickEpisode(details, season, episode) {
  const episodes = Array.isArray(details?.episodes) ? details.episodes : [];
  return episodes.find((entry) => Number(entry.season) === Number(season) && Number(entry.episode) === Number(episode));
}

async function resolveStreams(input) {
  const tmdbId = String(input.tmdbId || '').trim();
  const mediaType = input.mediaType === 'tv' || input.mediaType === 'series' ? 'tv' : 'movie';
  if (!/^\d+$/.test(tmdbId)) throw new Error('valid_tmdb_id_required');

  const wanted = await tmdbDetails(tmdbId, mediaType);
  const search = await compat('/v1/search', {
    providerId: PROVIDER_ID,
    query: wanted.title,
    page: 1
  });

  const candidates = Array.isArray(search?.items) ? search.items : [];
  const ranked = candidates
    .map((item) => ({ item, score: scoreCandidate(item, wanted) }))
    .sort((a, b) => b.score - a.score);

  if (!ranked.length || ranked[0].score < 45) {
    return { provider: 'MovieBox', title: wanted.title, streams: [], diagnostic: 'no_confident_match' };
  }

  const selected = ranked[0].item;
  const details = await compat('/v1/details', { providerId: PROVIDER_ID, ref: selected.ref });

  let targetRef = details?.item?.ref || selected.ref;
  if (mediaType === 'tv') {
    const season = Number(input.season);
    const episode = Number(input.episode);
    if (!Number.isInteger(season) || season < 1 || !Number.isInteger(episode) || episode < 1) {
      throw new Error('season_and_episode_required_for_tv');
    }
    const targetEpisode = pickEpisode(details, season, episode);
    if (!targetEpisode?.ref) {
      return { provider: 'MovieBox', title: wanted.title, streams: [], diagnostic: 'episode_not_found' };
    }
    targetRef = targetEpisode.ref;
  }

  const links = await compat('/v1/links', { providerId: PROVIDER_ID, ref: targetRef });
  const streams = (Array.isArray(links?.links) ? links.links : [])
    .filter((link) => typeof link?.url === 'string' && /^https?:\/\//i.test(link.url))
    .map((link, index) => ({
      name: `MovieBox - ${qualityLabel(link.height)}`,
      title: `${wanted.title}${wanted.year ? ` (${wanted.year})` : ''}`,
      url: link.url,
      quality: qualityLabel(link.height),
      headers: link.headers && typeof link.headers === 'object' ? link.headers : {},
      provider: 'MovieBoxBridge',
      type: link.protocol === 'hls' ? 'M3U8' : 'direct',
      subtitles: Array.isArray(link.subtitles) ? link.subtitles.map((sub) => ({
        lang: sub.language || 'Unknown',
        url: sub.url
      })) : [],
      sourceId: link.id || `moviebox-${index}`
    }));

  streams.sort((a, b) => {
    const height = (q) => q === '4K' ? 2160 : Number.parseInt(q, 10) || 0;
    return height(b.quality) - height(a.quality);
  });

  return {
    provider: links?.provider || 'MovieBox',
    title: wanted.title,
    matchedTitle: selected.title,
    matchedYear: selected.year,
    streams
  };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/healthz') {
      const health = await compat('/v1/health');
      return json(res, 200, { status: 'ok', service: 'nuvio-moviebox-bridge', compat: health });
    }

    if (req.method === 'POST' && req.url === '/v1/streams') {
      if (BRIDGE_TOKEN && req.headers.authorization !== `Bearer ${BRIDGE_TOKEN}`) {
        return json(res, 401, { error: 'unauthorized' });
      }
      const input = await readJson(req);
      const result = await resolveStreams(input);
      return json(res, 200, result);
    }

    return json(res, 404, { error: 'not_found' });
  } catch (error) {
    console.error('[MovieBoxBridge]', error);
    return json(res, 502, { error: error?.message || 'bridge_failed' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[MovieBoxBridge] listening on :${PORT}; compat=${COMPAT_URL}`);
});
