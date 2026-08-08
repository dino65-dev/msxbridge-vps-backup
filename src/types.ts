export type ContentKind = 'movie' | 'series' | 'episode';
export type PlaybackDecision = 'direct' | 'proxy' | 'remux' | 'transcode' | 'reject';
export type PlaybackMode = 'direct' | 'proxy' | 'remux' | 'transcode' | 'unsupported';
export type SubtitleMode = 'soft' | 'burn-in';
export type ResolveState = 'queued' | 'resolving' | 'playable' | 'ready' | 'failed';
export type PluginTrustState = 'DOWNLOADED' | 'INSPECTED' | 'TESTED' | 'AUTHORIZED' | 'ENABLED' | 'PENDING_REVIEW' | 'QUARANTINED';

export interface DeviceProfile {
  maxHeight: number;
  maxFps: number;
  maxBitrate: number;
  supportsHls: boolean;
  supportsMp4: boolean;
  supportsMkv: boolean;
  supportsH264: boolean;
  supportsHevc: boolean;
  supportsAac: boolean;
  supportsAc3: boolean;
  supportsSrt: boolean;
  preferredBufferSeconds: number;
  subtitleMode?: SubtitleMode;
  subtitleMaxHeight?: number;
}

export interface ContentItem {
  id: string;
  kind: ContentKind;
  title: string;
  overview: string;
  year?: number;
  season?: number;
  episode?: number;
  durationSeconds?: number;
  posterUrl?: string;
  backdropUrl?: string;
  provider?: string;
  providerRef?: string;
  logoUrl?: string;
  tags?: string[];
  rating?: number;
}

export interface SubtitleCandidate {
  id: string;
  language: string;
  url: string;
  format: 'srt' | 'vtt' | 'ass' | 'unknown';
}

export interface NormalizedSource {
  sourceId: string;
  provider: string;
  url: string;
  protocol: 'hls' | 'mp4' | 'file' | 'unknown';
  container: 'mpegts' | 'mp4' | 'mkv' | 'unknown';
  videoCodec: 'h264' | 'hevc' | 'av1' | 'vp9' | 'unknown';
  audioCodec: 'aac' | 'ac3' | 'eac3' | 'opus' | 'unknown';
  height?: number;
  fps?: number;
  bitrate?: number;
  headers?: Record<string, string>;
  expiresAt?: number;
  subtitleUrl?: string;
  subtitles?: SubtitleCandidate[];
}

export interface RankedSource extends NormalizedSource {
  decision: PlaybackDecision;
  score: number;
  reasons: string[];
}

export interface MediaProbe {
  container?: string;
  videoCodec?: NormalizedSource['videoCodec'];
  videoProfile?: string;
  videoLevel?: number;
  width?: number;
  height?: number;
  fps?: number;
  bitDepth?: number;
  audioCodec?: NormalizedSource['audioCodec'];
  audioChannels?: number;
  audioSampleRate?: number;
  bitrate?: number;
  error?: string;
}

export interface PlaybackPlan {
  mode: PlaybackMode;
  sourceId: string;
  url: string;
  videoCodec?: NormalizedSource['videoCodec'];
  audioCodec?: NormalizedSource['audioCodec'];
  container?: NormalizedSource['container'];
  width?: number;
  height?: number;
  bitrate?: number;
  reason: string;
  subtitle?: SubtitleCandidate;
  subtitleMode?: SubtitleMode;
  subtitleDelayMs?: number;
}

export interface ResolveJob {
  id: string;
  deviceId: string;
  contentId: string;
  type: 'movie' | 'series';
  state: ResolveState;
  createdAt: number;
  updatedAt: number;
  sourcesFound: number;
  sources: RankedSource[];
  plans: PlaybackPlan[];
  providerErrors: Array<{ provider: string; message: string }>;
}

export interface ProviderCatalogPage {
  title: string;
  items: ContentItem[];
  hasNext: boolean;
}

export interface ProviderDetails extends ContentItem {
  episodes: ContentItem[];
  seasons: number[];
}
