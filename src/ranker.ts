import type { DeviceProfile, NormalizedSource, RankedSource } from './types.js';

const protocolPoints: Record<NormalizedSource['protocol'], number> = { hls: 18, mp4: 16, file: 0, unknown: -25 };
const containerPoints: Record<NormalizedSource['container'], number> = { mpegts: 12, mp4: 10, mkv: -10, unknown: -20 };

export function rankSource(source: NormalizedSource, profile: DeviceProfile): RankedSource {
  const reasons: string[] = [];
  let score = 50 + protocolPoints[source.protocol] + containerPoints[source.container];
  let decision: RankedSource['decision'] = 'direct';

  if (source.videoCodec === 'h264' && profile.supportsH264) { score += 24; reasons.push('H.264 supported'); }
  else if (source.videoCodec === 'hevc' && profile.supportsHevc) { score += 8; reasons.push('HEVC confirmed by calibration'); }
  else { decision = 'transcode'; score -= 40; reasons.push(`${source.videoCodec} requires video transcode`); }

  if (source.audioCodec === 'aac' && profile.supportsAac) { score += 16; reasons.push('AAC supported'); }
  else if (source.audioCodec === 'ac3' && profile.supportsAc3) { score += 4; reasons.push('AC-3 confirmed by calibration'); }
  else if (decision !== 'transcode') { decision = 'transcode'; score -= 18; reasons.push(`${source.audioCodec} requires audio transcode`); }

  if (source.height && source.height > profile.maxHeight) { decision = 'transcode'; score -= 14; reasons.push(`Height exceeds ${profile.maxHeight}p`); }
  if (source.fps && source.fps > profile.maxFps) { decision = 'transcode'; score -= 8; reasons.push(`Frame rate exceeds ${profile.maxFps}fps`); }
  if (source.bitrate && source.bitrate > profile.maxBitrate) { score -= 9; reasons.push('Bitrate above device preference'); }

  const supportedContainer = (source.container === 'mpegts' && profile.supportsHls) ||
    (source.container === 'mp4' && profile.supportsMp4) ||
    (source.container === 'mkv' && profile.supportsMkv);
  if (!supportedContainer && decision !== 'transcode') { decision = 'remux'; score -= 8; reasons.push('Container requires remux'); }
  if (source.headers && Object.keys(source.headers).length > 0 && decision === 'direct') { decision = 'proxy'; score -= 3; reasons.push('Upstream requires server headers'); }
  if (source.expiresAt && source.expiresAt < Date.now()) { decision = 'reject'; score = -1000; reasons.push('Source URL has expired'); }

  return { ...source, decision, score, reasons };
}

export function rankSources(sources: NormalizedSource[], profile: DeviceProfile): RankedSource[] {
  return sources.map((source) => rankSource(source, profile)).sort((a, b) => b.score - a.score);
}
