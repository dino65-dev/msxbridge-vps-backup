import type { ContentItem } from './types.js';

/** Seed data keeps the first MSX slice usable before metadata-provider integration. */
export const catalog: ContentItem[] = [
  {
    id: 'fixture-sintel', kind: 'movie', title: 'Sintel (test fixture)', year: 2010,
    overview: 'A controlled, open test title used to verify AVPlay, seeking and subtitles.', durationSeconds: 888,
    posterUrl: 'https://placehold.co/240x360/111827/ffffff.jpg?text=Sintel',
    backdropUrl: 'https://placehold.co/960x540/111827/ffffff.jpg?text=Sintel'
  },
  {
    id: 'fixture-hls', kind: 'movie', title: 'HLS Compatibility Test', year: 2026,
    overview: 'A controlled H.264/AAC HLS test card.', durationSeconds: 600,
    posterUrl: 'https://placehold.co/240x360/1d4ed8/ffffff.jpg?text=HLS',
    backdropUrl: 'https://placehold.co/960x540/1d4ed8/ffffff.jpg?text=HLS'
  },
  {
    id: 'fixture-calibration', kind: 'movie', title: 'TV Capability Calibration', year: 2026,
    overview: 'Run the eight controlled codec, container, subtitle and seek tests.',
    posterUrl: 'https://placehold.co/240x360/047857/ffffff.jpg?text=TV+Test',
    backdropUrl: 'https://placehold.co/960x540/047857/ffffff.jpg?text=TV+Test'
  }
];

export function getContent(id: string): ContentItem | undefined {
  return catalog.find((item) => item.id === id);
}
