import { spawn } from 'node:child_process';
import { assertSafeUpstreamUrl } from './security.js';
import { rankSource } from './ranker.js';
import type { DeviceProfile, MediaProbe, NormalizedSource, PlaybackPlan } from './types.js';

function rational(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const [numerator, denominator] = value.split('/').map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return undefined;
  return Math.round((numerator / denominator) * 100) / 100;
}

function videoCodec(value: unknown): NormalizedSource['videoCodec'] | undefined {
  const text = String(value ?? '').toLowerCase();
  if (text === 'h264' || text === 'avc') return 'h264';
  if (text === 'hevc' || text === 'h265') return 'hevc';
  if (text === 'av1') return 'av1';
  if (text === 'vp9') return 'vp9';
  return undefined;
}

function audioCodec(value: unknown): NormalizedSource['audioCodec'] | undefined {
  const text = String(value ?? '').toLowerCase();
  if (text === 'aac') return 'aac';
  if (text === 'ac3') return 'ac3';
  if (text === 'eac3') return 'eac3';
  if (text === 'opus') return 'opus';
  return undefined;
}

export async function ffprobeMedia(source: NormalizedSource): Promise<MediaProbe> {
  await assertSafeUpstreamUrl(source.url);
  const headers = Object.entries(source.headers ?? {})
    .filter(([key, value]) => /^[A-Za-z-]{1,64}$/.test(key) && !/[\r\n]/.test(value))
    .map(([key, value]) => `${key}: ${value}\r\n`).join('');
  const args = [
    '-v', 'error',
    ...(headers ? ['-headers', headers] : []),
    '-show_entries', 'format=format_name,bit_rate:stream=codec_type,codec_name,profile,level,width,height,avg_frame_rate,bit_rate,channels,sample_rate,bits_per_raw_sample',
    '-of', 'json', source.url
  ];
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('ffprobe timed out')); }, 12_000);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(stderr || `ffprobe exited ${code}`)); });
  });
  const parsed = JSON.parse(output) as { format?: Record<string, unknown>; streams?: Array<Record<string, unknown>> };
  const video = parsed.streams?.find((stream) => stream.codec_type === 'video') ?? {};
  const audio = parsed.streams?.find((stream) => stream.codec_type === 'audio') ?? {};
  return {
    container: typeof parsed.format?.format_name === 'string' ? parsed.format.format_name : undefined,
    videoCodec: videoCodec(video.codec_name), videoProfile: typeof video.profile === 'string' ? video.profile : undefined,
    videoLevel: Number.isFinite(Number(video.level)) ? Number(video.level) : undefined,
    width: Number.isFinite(Number(video.width)) ? Number(video.width) : undefined,
    height: Number.isFinite(Number(video.height)) ? Number(video.height) : undefined,
    fps: rational(video.avg_frame_rate), bitDepth: Number.isFinite(Number(video.bits_per_raw_sample)) ? Number(video.bits_per_raw_sample) : undefined,
    audioCodec: audioCodec(audio.codec_name), audioChannels: Number.isFinite(Number(audio.channels)) ? Number(audio.channels) : undefined,
    audioSampleRate: Number.isFinite(Number(audio.sample_rate)) ? Number(audio.sample_rate) : undefined,
    bitrate: Number.isFinite(Number(parsed.format?.bit_rate)) ? Number(parsed.format?.bit_rate) : undefined
  };
}

export function applyProbe(source: NormalizedSource, probe: MediaProbe): NormalizedSource {
  return {
    ...source,
    videoCodec: probe.videoCodec ?? source.videoCodec,
    audioCodec: probe.audioCodec ?? source.audioCodec,
    height: probe.height ?? source.height,
    fps: probe.fps ?? source.fps,
    bitrate: probe.bitrate ?? source.bitrate,
    container: probe.container?.includes('matroska') ? 'mkv' : probe.container?.includes('mp4') ? 'mp4' : probe.container?.includes('mpegts') ? 'mpegts' : source.container
  };
}

export function planSamsung2017Playback(source: NormalizedSource, profile: DeviceProfile): PlaybackPlan {
  const ranked = rankSource(source, profile);
  const mode = ranked.decision === 'reject' ? 'unsupported' : ranked.decision;
  const reason = ranked.reasons.join('; ') || 'Source has no compatibility evidence';
  return { mode, sourceId: source.sourceId, url: source.url, videoCodec: source.videoCodec, audioCodec: source.audioCodec, container: source.container, width: undefined, height: source.height, bitrate: source.bitrate, reason };
}
