import assert from 'node:assert/strict';
import test from 'node:test';
import { catalog } from '../catalog.js';
import { autoPlayPage, detailsPage, diagnosticsPage, homePage, menuObject, searchPage, sourcesPage, startObject } from '../msx.js';
import type { RankedSource, SubtitleCandidate } from '../types.js';

const route = (suffix: string) => `https://bridge.example/d/device${suffix}`;

test('starts with the native MSX menu instead of a flat content page', () => {
  const start = startObject('MSXBridge', route('/menu.json'));
  assert.equal(start.parameter, `menu:${route('/menu.json')}`);
  assert.equal(start.welcome, 'menu');

  const menu = menuObject(route) as { menu: Array<{ id?: string; data?: string }> };
  assert.deepEqual(menu.menu.filter((item) => item.id).map((item) => item.id), ['home', 'movies', 'series', 'search', 'settings']);
  assert.equal(menu.menu[0]?.data, route('/home.json'));
});

test('renders poster cards with details, play and source actions', () => {
  const home = homePage(route, [], [{ title: 'Trending', items: catalog, hasNext: false }]) as {
    template: { layout: string; type: string };
    items: Array<{ image?: string; action?: string; options?: { items?: Array<{ action?: string }> } }>;
  };
  assert.equal(home.template.type, 'separate');
  assert.equal(home.template.layout, '0,0,2,4');
  assert.equal(home.items.length, catalog.length);
  for (const card of home.items) {
    assert.match(card.image ?? '', /\/poster\.jpg$/);
    assert.match(card.action ?? '', /^content:https:\/\//);
    assert.match(card.options?.items?.[0]?.action ?? '', /^content:https:\/\/.+\/resolve\//);
    assert.match(card.options?.items?.[2]?.action ?? '', /^content:https:\/\/.+\/sources\//);
  }
});

test('details hero exposes explicit Play and Sources buttons', () => {
  const details = detailsPage(catalog[0], route, route('/resolve/fixture-sintel.json'), route('/sources/fixture-sintel.json')) as {
    pages: Array<{ items: Array<{ id?: string; action?: string; properties?: Record<string, string> }> }>;
  };
  const hero = details.pages[0]?.items ?? [];
  assert.equal(hero.find((item) => item.id === 'play')?.action, `content:${route('/resolve/fixture-sintel.json')}`);
  assert.equal(hero.find((item) => item.id === 'sources')?.action, `content:${route('/sources/fixture-sintel.json')}`);
});

test('gives Samsung AVPlay enough time to fill its initial buffer', () => {
  const play = autoPlayPage(catalog[0], route, 'https://bridge.example/play/session/stream.m3u8') as {
    pages: Array<{ items: Array<{ properties?: Record<string, string> }> }>;
  };
  assert.equal(play.pages[0]?.items[0]?.properties?.['tizen:buffer:size'], '10');
  assert.equal(play.pages[0]?.items[0]?.properties?.['tizen:buffer:timeout'], '30');
});

test('passes a signed native subtitle URL and delay to Samsung AVPlay', () => {
  const play = autoPlayPage(catalog[0], route, {
    url: 'https://bridge.example/play/session/stream.mp4',
    subtitleUrl: 'https://bridge.example/d/device/subtitle/session/signature/track.srt?expires=1',
    subtitleDelayMs: -500
  }) as { pages: Array<{ items: Array<{ properties?: Record<string, string> }> }> };
  const properties = play.pages[0]?.items[0]?.properties ?? {};
  assert.match(properties['tizen:subtitle:url'] ?? '', /track\.srt/);
  assert.equal(properties['tizen:subtitle:delay'], '-500');
  assert.equal(properties['tizen:subtitle:type'], 'border');
});

test('offers soft subtitle timing, off and manual burn-in controls', () => {
  const subtitle: SubtitleCandidate = { id: 'english', language: 'English', url: 'https://media.example/en.vtt', format: 'vtt' };
  const source: RankedSource = {
    sourceId: 'source', provider: 'MovieBox', url: 'https://media.example/movie.mp4', protocol: 'mp4', container: 'mp4',
    videoCodec: 'h264', audioCodec: 'aac', height: 1080, decision: 'direct', score: 100, reasons: ['H.264 supported'], subtitles: [subtitle]
  };
  const page = sourcesPage(catalog[0], route, [source], new Map([['source', {
    url: 'https://bridge.example/play/session/stream.mp4', subtitleUrl: 'https://bridge.example/d/device/subtitle/session/signature/track.srt?expires=1', subtitleDelayMs: 0
  }]]), { jobId: 'job', candidate: subtitle, mode: 'soft', delayMs: 0 }) as { items: Array<{ id: string; action?: string; properties?: Record<string, string> }> };
  assert.equal(page.items.find((item) => item.id === 'source-0')?.properties?.['tizen:subtitle:delay'], '0');
  assert.match(page.items.find((item) => item.id === 'subtitle-delay--500')?.action ?? '', /delayMs=-500/);
  assert.match(page.items.find((item) => item.id === 'subtitle-toggle-mode')?.action ?? '', /subtitleMode=burn-in/);
  assert.match(page.items.find((item) => item.id === 'subtitle-off')?.action ?? '', /job=job$/);
});

test('includes a controlled native AVPlay subtitle diagnostic', () => {
  const diagnostics = diagnosticsPage(route) as { items: Array<{ id: string; properties?: Record<string, string> }> };
  assert.equal(diagnostics.items.find((item) => item.id === 'subtitle-soft')?.properties?.['tizen:subtitle:url'], route('/diagnostics.srt'));
});

test('series details direct viewers to episodes while episode cards retain playback actions', () => {
  const series = { ...catalog[0], id: 'series', kind: 'series' as const, title: 'Series' };
  const episode = { ...catalog[0], id: 'episode', kind: 'episode' as const, title: 'Episode 1', season: 1, episode: 1 };
  const details = detailsPage(series, route, route('/resolve/series.json'), route('/sources/series.json'), undefined, [episode]) as {
    pages: Array<{ items: Array<{ id?: string; action?: string; options?: { items?: Array<{ action?: string }> } }> }>;
  };
  assert.match(details.pages[0]?.items.find((item) => item.id === 'play')?.action ?? '', /^info:This series has 1 episodes/);
  assert.match(details.pages[1]?.items[0]?.action ?? '', /\/content\/episode\.json$/);
  assert.match(details.pages[1]?.items[0]?.options?.items?.[0]?.action ?? '', /\/resolve\/episode\.json$/);
});

test('search launches the official MSX input interaction plugin', () => {
  const search = searchPage(route) as { pages: Array<{ items: Array<{ action?: string }> }> };
  const action = search.pages[0]?.items[0]?.action ?? '';
  assert.match(action, /^content:request:interaction:https:\/\//);
  assert.match(action, /q=\{INPUT\}/);
  assert.match(action, /\|default:2\|en\|Search MovieBox/);
  assert.match(action, /@https:\/\/msx\.benzac\.de\/interaction\/input\.html$/);
});

test('series details do not discard episodes after episode 30', () => {
  const series = { ...catalog[0], id: 'long-series', kind: 'series' as const, title: 'Long Series' };
  const episodes = Array.from({ length: 31 }, (_, index) => ({
    ...catalog[0],
    id: `episode-${index + 1}`,
    kind: 'episode' as const,
    title: `Episode ${index + 1}`,
    season: 1,
    episode: index + 1
  }));
  const details = detailsPage(series, route, route('/resolve/long-series.json'), route('/sources/long-series.json'), undefined, episodes) as {
    pages: Array<{ items: Array<{ id?: string }> }>;
  };
  assert.equal(details.pages.length, 7);
  assert.deepEqual(details.pages.slice(1).flatMap((page) => page.items).map((item) => item.id), episodes.map((episode) => episode.id));
});
