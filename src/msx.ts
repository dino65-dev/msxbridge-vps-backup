import type { ContentItem, ProviderCatalogPage, RankedSource, SubtitleCandidate, SubtitleMode } from './types.js';
import { catalog } from './catalog.js';

type DeviceRoute = (suffix: string) => string;
export interface PlaybackAsset { url: string; subtitleUrl?: string; subtitleDelayMs?: number }

function playbackProperties(item: ContentItem, asset: PlaybackAsset): Record<string, string> {
  const properties: Record<string, string> = {
    'resume:key': item.id,
    'tizen:buffer:size': '10',
    'tizen:buffer:timeout': '30',
    'tizen:display:mode': 'PLAYER_DISPLAY_MODE_LETTER_BOX'
  };
  if (asset.subtitleUrl) {
    properties['tizen:subtitle:url'] = asset.subtitleUrl;
    properties['tizen:subtitle:delay'] = String(asset.subtitleDelayMs ?? 0);
    properties['tizen:subtitle:type'] = 'border';
    properties['tizen:subtitle:size'] = 'medium';
    properties['tizen:subtitle:color'] = '#FFFFFF';
  }
  return properties;
}

function poster(item: ContentItem, route: DeviceRoute): string {
  return route(`/image/${encodeURIComponent(item.id)}/poster.jpg`);
}

function backdrop(item: ContentItem, route: DeviceRoute): string {
  return route(`/image/${encodeURIComponent(item.id)}/backdrop.jpg`);
}

function detailsUrl(item: ContentItem, route: DeviceRoute): string {
  return route(`/content/${encodeURIComponent(item.id)}.json`);
}

function resolveUrl(item: ContentItem, route: DeviceRoute): string {
  return route(`/resolve/${encodeURIComponent(item.id)}.json`);
}

function sourcesUrl(item: ContentItem, route: DeviceRoute): string {
  return route(`/sources/${encodeURIComponent(item.id)}.json`);
}

function itemOptions(item: ContentItem, route: DeviceRoute): Record<string, unknown> {
  return {
    headline: item.title,
    items: [
      { type: 'control', layout: '0,0,8,1', icon: 'play', label: 'Play', action: `content:${resolveUrl(item, route)}` },
      { type: 'control', layout: '0,1,8,1', icon: 'info', label: 'Details', action: `content:${detailsUrl(item, route)}` },
      { type: 'control', layout: '0,2,8,1', icon: 'list', label: 'Sources', action: `content:${sourcesUrl(item, route)}` }
    ]
  };
}

function catalogItem(item: ContentItem, route: DeviceRoute, footer?: string): Record<string, unknown> {
  return {
    id: item.id,
    title: item.title,
    titleFooter: footer ?? [item.year, item.kind === 'series' ? 'Series' : item.kind === 'episode' ? 'Episode' : 'Movie'].filter(Boolean).join(' • '),
    image: poster(item, route),
    imageOverlay: 0,
    imageBoundary: true,
    action: `content:${detailsUrl(item, route)}`,
    options: itemOptions(item, route)
  };
}

function gridPage(headline: string, route: DeviceRoute, items: ContentItem[], footer?: (item: ContentItem) => string): Record<string, unknown> {
  return {
    type: 'pages',
    cache: false,
    restore: true,
    preload: 'none',
    headline,
    template: {
      type: 'separate',
      layout: '0,0,2,4',
      color: 'msx-glass',
      imageFiller: 'cover',
      imageOverlay: 0,
      imageBoundary: true,
      round: true
    },
    items: items.slice(0, 18).map((item, index) => ({
      ...catalogItem(item, route, footer?.(item)),
      focus: index === 0
    }))
  };
}

export function startObject(name: string, menuUrl: string): Record<string, unknown> {
  return {
    name,
    version: '0.4.0',
    parameter: `menu:${menuUrl}`,
    welcome: 'menu',
    launcher: { icon: 'play', color: '#e50914' }
  };
}

export function menuObject(route: DeviceRoute): Record<string, unknown> {
  return {
    name: 'MSXBridge',
    version: '0.4.0',
    flag: 'stremio-menu',
    cache: false,
    restore: true,
    refocus: true,
    style: 'overlay-separator',
    headline: 'MSXBridge',
    extension: 'Samsung TV',
    menu: [
      { id: 'home', icon: 'home', label: 'Home', focus: true, data: route('/home.json') },
      { id: 'movies', icon: 'movie', label: 'Movies', data: route('/catalog/movie.json') },
      { id: 'series', icon: 'tv', label: 'Series', data: route('/catalog/series.json') },
      { id: 'search', icon: 'search', label: 'Search', data: route('/search.json') },
      { type: 'separator', label: 'Playback' },
      { id: 'settings', icon: 'settings', label: 'Settings', data: route('/settings.json') }
    ]
  };
}

export function homePage(route: DeviceRoute, continueWatching: Array<{ item: ContentItem; positionSeconds: number }>, pages: ProviderCatalogPage[]): Record<string, unknown> {
  const resume = continueWatching.map(({ item, positionSeconds }) => ({ item, footer: `Resume • ${Math.floor(positionSeconds / 60)} min` }));
  const discovered = pages.flatMap((page) => page.items.map((item) => ({ item, footer: page.title })));
  const fallback = discovered.length ? [] : catalog.map((item) => ({ item, footer: 'TV compatibility' }));
  const unique = [...resume, ...discovered, ...fallback].filter((entry, index, entries) => entries.findIndex((candidate) => candidate.item.id === entry.item.id) === index).slice(0, 18);
  const hero = unique[0]?.item ?? catalog[0];
  return {
    ...gridPage('Home', route, unique.map((entry) => entry.item), (item) => unique.find((entry) => entry.item.id === item.id)?.footer ?? ''),
    flag: 'home-grid',
    background: backdrop(hero, route),
    extension: 'MovieBox'
  };
}

export function catalogPage(title: string, route: DeviceRoute, items: ContentItem[], page: number, hasNext: boolean): Record<string, unknown> {
  const result = gridPage(title, route, items);
  if (hasNext) {
    (result.items as Array<Record<string, unknown>>).push({
      id: `more-${page + 1}`,
      title: 'More',
      titleFooter: `Page ${page + 1}`,
      icon: 'arrow-forward',
      action: `content:${route(`/catalog/${title.toLowerCase()}.json?page=${page + 1}`)}`
    });
  }
  return { ...result, flag: `catalog-${title.toLowerCase()}-${page}` };
}

export function searchPage(route: DeviceRoute, query?: string, items: ContentItem[] = [], page = 1, hasNext = false): Record<string, unknown> {
  if (!query) {
    return {
      type: 'pages',
      headline: 'Search',
      cache: false,
      pages: [{
        items: [{
          id: 'search-input',
          type: 'button',
          layout: '1,2,10,2',
          icon: 'search',
          iconSize: 'large',
          label: 'Search MovieBox',
          action: `content:request:interaction:${route('/search.json?q={INPUT}')}|default:2|en|Search MovieBox|||Enter at least two characters|Movie or series@https://msx.benzac.de/interaction/input.html`,
          focus: true
        }]
      }]
    };
  }
  const result = gridPage(`Search • ${query}`, route, items);
  if (hasNext) {
    (result.items as Array<Record<string, unknown>>).push({
      id: `search-more-${page + 1}`,
      title: 'More results',
      titleFooter: `Page ${page + 1}`,
      icon: 'arrow-forward',
      action: `content:${route(`/search.json?q=${encodeURIComponent(query)}&page=${page + 1}`)}`
    });
  }
  return { ...result, flag: `search-${page}` };
}

function episodePages(episodes: ContentItem[], route: DeviceRoute): Array<Record<string, unknown>> {
  const pages: Array<Record<string, unknown>> = [];
  for (let offset = 0; offset < episodes.length; offset += 6) {
    const slice = episodes.slice(offset, offset + 6);
    pages.push({
      headline: `Episodes ${offset + 1}–${offset + slice.length}`,
      items: slice.map((episode, index) => ({
        ...catalogItem(episode, route, `S${episode.season ?? 1} E${episode.episode ?? '?'} • ${episode.title}`),
        type: 'separate',
        layout: `${index * 2},1,2,4`,
        color: 'msx-glass',
        imageFiller: 'cover'
      }))
    });
  }
  return pages;
}

export function detailsPage(item: ContentItem, route: DeviceRoute, resolverUrl: string, sourceListUrl: string, resumeSeconds?: number, episodes: ContentItem[] = []): Record<string, unknown> {
  const metadata = [item.year, item.rating ? `★ ${item.rating.toFixed(1)}` : undefined, item.tags?.slice(0, 3).join(' • ')].filter(Boolean).join(' • ');
  const overview = item.overview?.trim() || 'Choose Play to find the best compatible stream.';
  const browseEpisodes = item.kind === 'series' && episodes.length > 0;
  const episodeHint = `This series has ${episodes.length} episodes. Press Right to browse them, then select an episode to play.`;
  return {
    type: 'pages',
    flag: `details-${item.id}`,
    cache: false,
    restore: true,
    headline: item.title,
    background: backdrop(item, route),
    pages: [{
      background: backdrop(item, route),
      items: [
        {
          type: 'separate', layout: '0,0,3,6', color: 'msx-black-soft', image: poster(item, route),
          imageFiller: 'fit', imageOverlay: 0, title: item.title, titleFooter: metadata
        },
        {
          type: 'space', layout: '3,0,9,3', color: 'msx-black-soft', headline: item.title,
          text: `${metadata ? `${metadata}\n\n` : ''}${overview.slice(0, 520)}`
        },
        {
          id: 'play', type: 'button', layout: '3,3,3,2', icon: browseEpisodes ? 'list' : 'play',
          label: browseEpisodes ? 'Browse episodes' : resumeSeconds && resumeSeconds > 10 ? `Resume ${Math.floor(resumeSeconds / 60)}m` : 'Play',
          color: 'msx-white', action: browseEpisodes ? `info:${episodeHint}` : `content:${resolverUrl}`, focus: true
        },
        { id: 'sources', type: 'button', layout: '6,3,3,2', icon: 'list', label: browseEpisodes ? `${episodes.length} episodes` : 'Sources', action: browseEpisodes ? `info:${episodeHint}` : `content:${sourceListUrl}` },
        { id: 'info', type: 'button', layout: '9,3,3,2', icon: 'info', label: browseEpisodes ? 'About' : 'Details', action: `info:${overview.slice(0, 700)}` }
      ]
    }, ...episodePages(episodes, route)]
  };
}

export function resolvingPage(item: ContentItem, route: DeviceRoute, statusUrl: string, found: number): Record<string, unknown> {
  return {
    type: 'pages',
    flag: 'resolver',
    cache: false,
    restore: false,
    headline: `Finding streams • ${item.title}`,
    pages: [{ items: [{
      id: 'resolver-status', type: 'default', layout: '2,1,8,4', color: 'msx-glass',
      image: poster(item, route), imageWidth: 2.2, imageFiller: 'cover', icon: 'refresh',
      headline: 'Finding the best stream…', text: found ? `${found} candidate${found === 1 ? '' : 's'} checked` : 'Contacting MovieBox',
      action: 'live', live: { type: 'lifetime', duration: 1000, preload: false, over: { action: `replace:content:resolver:${statusUrl}` } }
    }] }]
  };
}

export function autoPlayPage(item: ContentItem, route: DeviceRoute, playValue: string | PlaybackAsset, resumeSeconds?: number): Record<string, unknown> {
  const asset = typeof playValue === 'string' ? { url: playValue } : playValue;
  return {
    type: 'pages', cache: false, restore: false, headline: item.title,
    ready: { action: `video:${asset.url}` },
    pages: [{ items: [{
      id: 'play-now', type: 'button', layout: '2,2,8,2', icon: 'play', iconSize: 'large', label: 'Play now',
      action: `video:${asset.url}`, playerLabel: item.title, image: poster(item, route), imageWidth: 2,
      properties: { ...playbackProperties(item, asset), 'resume:position': String(resumeSeconds ?? 0) }, focus: true
    }] }]
  };
}

interface SubtitleSelectionView {
  jobId: string;
  candidate?: SubtitleCandidate;
  mode?: SubtitleMode;
  delayMs?: number;
}

function subtitleSelectionUrl(item: ContentItem, route: DeviceRoute, selection: SubtitleSelectionView, delayMs: number, mode: SubtitleMode): string {
  const candidate = selection.candidate;
  if (!candidate) return route(`/sources/${encodeURIComponent(item.id)}.json?job=${encodeURIComponent(selection.jobId)}`);
  return route(`/sources/${encodeURIComponent(item.id)}.json?job=${encodeURIComponent(selection.jobId)}&subtitle=${encodeURIComponent(candidate.id)}&subtitleMode=${mode}&delayMs=${delayMs}`);
}

export function sourcesPage(item: ContentItem, route: DeviceRoute, sources: RankedSource[], playUrls: Map<string, PlaybackAsset>, selection: SubtitleSelectionView): Record<string, unknown> {
  const subtitle = selection.candidate;
  const playable = sources.filter((source) => source.decision !== 'reject').slice(0, 10).map((source, index) => ({
    id: `source-${index}`, label: `${source.provider} • ${source.height ?? '?'}p`,
    extensionLabel: `${source.decision.toUpperCase()} • ${source.videoCodec.toUpperCase()}/${source.audioCodec.toUpperCase()}${subtitle ? selection.mode === 'burn-in' ? ' • BURN-IN' : ' • SOFT SUB' : ''}`,
    icon: 'play', action: `video:${playUrls.get(source.sourceId)?.url}`, playerLabel: item.title,
    properties: playbackProperties(item, playUrls.get(source.sourceId) ?? { url: '' })
  }));
  const subtitleItems = subtitle ? [] : sources.flatMap((source) => source.subtitles ?? []).filter((candidate, index, all) => all.findIndex((value) => value.id === candidate.id) === index).slice(0, 8).map((candidate, index) => ({
    id: `subtitle-${index}`, label: `Subtitles • ${candidate.language}`, extensionLabel: 'Native soft SRT • no video re-encode', icon: 'subtitles',
    action: `content:${route(`/sources/${encodeURIComponent(item.id)}.json?job=${encodeURIComponent(selection.jobId)}&subtitle=${encodeURIComponent(candidate.id)}&subtitleMode=soft&delayMs=0`)}`
  }));
  const delayItems = subtitle && selection.mode === 'soft' ? [-2000, -1000, -500, 0, 500, 1000, 2000].map((delay) => ({
    id: `subtitle-delay-${delay}`,
    label: delay === 0 ? 'Subtitle timing • Original' : delay < 0 ? `Subtitle timing • Earlier ${Math.abs(delay) / 1000}s` : `Subtitle timing • Later +${delay / 1000}s`,
    extensionLabel: delay === (selection.delayMs ?? 0) ? 'Selected' : 'Adjust constant subtitle offset',
    icon: delay === (selection.delayMs ?? 0) ? 'check' : 'time',
    action: `content:${subtitleSelectionUrl(item, route, selection, delay, 'soft')}`
  })) : [];
  const controls = subtitle ? [
    {
      id: 'subtitle-toggle-mode', label: selection.mode === 'burn-in' ? 'Use native soft subtitles' : 'Burn-in fallback',
      extensionLabel: selection.mode === 'burn-in' ? 'Faster start • adjustable timing' : 'Use only if captions do not appear',
      icon: 'subtitles', action: `content:${subtitleSelectionUrl(item, route, selection, selection.delayMs ?? 0, selection.mode === 'burn-in' ? 'soft' : 'burn-in')}`
    },
    {
      id: 'subtitle-off', label: 'Subtitles off', extensionLabel: 'Return to unmodified playback', icon: 'close',
      action: `content:${route(`/sources/${encodeURIComponent(item.id)}.json?job=${encodeURIComponent(selection.jobId)}`)}`
    }
  ] : [];
  const items = [...playable, ...delayItems, ...controls, ...subtitleItems];
  if (!items.length) items.push({ id: 'no-source', label: 'No compatible sources', extensionLabel: 'Return and try again', icon: 'warning', action: `content:${detailsUrl(item, route)}` });
  return {
    type: 'list', cache: false, headline: `Sources • ${item.title}`,
    template: { type: 'control', layout: '0,0,12,1', color: 'msx-glass' },
    items: items.map((entry, index) => ({ ...entry, focus: index === 0 }))
  };
}

export function settingsPage(route: DeviceRoute): Record<string, unknown> {
  return {
    type: 'list', headline: 'Playback settings',
    template: { type: 'control', layout: '0,0,12,1', color: 'msx-glass' },
    items: [
      { id: 'profile', icon: 'tv', label: 'Samsung 2017 profile', extensionLabel: 'Direct 1080p when compatible', action: 'info:Direct play is preferred. Unsupported media is converted to a Samsung-safe H.264/AAC stream.' },
      { id: 'subtitles', icon: 'subtitles', label: 'Subtitles', extensionLabel: 'Native soft SRT by default', action: 'info:SRT, VTT and ASS tracks are normalized to SRT for AVPlay. Burn-in remains available from Sources if captions do not appear.' },
      { id: 'diagnostics', icon: 'settings', label: 'Diagnostics', extensionLabel: 'Playback tests', action: `content:${route('/diagnostics.json')}` }
    ]
  };
}

export function diagnosticsPage(route: DeviceRoute): Record<string, unknown> {
  const playback = (id: string, label: string, extensionLabel: string, url: string, properties: Record<string, string> = {}) => ({
    id, icon: 'play', label, extensionLabel, playerLabel: label, action: `video:${url}`,
    properties: { 'tizen:buffer:size': '10', 'tizen:buffer:timeout': '30', 'tizen:display:mode': 'PLAYER_DISPLAY_MODE_LETTER_BOX', ...properties }
  });
  return {
    type: 'list', headline: 'Samsung 2017 diagnostics',
    template: { type: 'control', layout: '0,0,12,1', color: 'msx-glass' },
    items: [
      playback('mp4', 'H.264/AAC MP4', 'Controlled direct playback', 'https://media.w3.org/2010/05/sintel/trailer.mp4'),
      playback('hls', 'H.264/AAC HLS', 'Controlled adaptive playback', 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'),
      playback('subtitle-soft', 'Native soft SRT', 'AVPlay external subtitle test', 'https://media.w3.org/2010/05/sintel/trailer.mp4', {
        'tizen:subtitle:url': route('/diagnostics.srt'), 'tizen:subtitle:delay': '0', 'tizen:subtitle:type': 'border', 'tizen:subtitle:size': 'medium', 'tizen:subtitle:color': '#FFFFFF'
      }),
      playback('subtitles', 'Burned-in subtitle HLS', 'Server-rendered fallback', route('/diagnostics/subtitle-burned.m3u8'))
    ]
  };
}
