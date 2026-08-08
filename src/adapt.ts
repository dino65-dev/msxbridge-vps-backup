import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assertSafeUpstreamUrl } from './security.js';
import type { NormalizedSource } from './types.js';

type AdaptMode = 'remux' | 'transcode';

// FFmpeg's filter-graph parser treats an unescaped comma as a filter separator.
// The backslash must survive the JavaScript string and reach FFmpeg verbatim.
export const samsungScaleFilter = 'scale=w=min(1280\\,iw):h=-2:force_original_aspect_ratio=decrease';
// Tizen 3.0 supports basic HLS v3 tags but not EXT-X-INDEPENDENT-SEGMENTS.
export const samsungHlsFlags = 'temp_file';
// A growing playlist is treated as live by AVPlay. Pace prerecorded input at
// its native rate so the live edge cannot jump several segments ahead.
export const samsungInputReadRate = '1';
export const samsungInitialSegmentCount = 3;

export class AdaptationManager {
  private readonly active = new Map<string, ChildProcess>();
  private activeTranscode?: string;

  constructor(private readonly root: string, private readonly ffmpegPath = process.env.FFMPEG_PATH ?? 'ffmpeg') {}

  private directory(sessionId: string): string { return resolve(this.root, 'adapt', sessionId); }
  private playlistPath(sessionId: string): string { return join(this.directory(sessionId), 'index.m3u8'); }

  private async initialPlaylist(path: string): Promise<string | undefined> {
    try {
      const playlist = await readFile(path, 'utf8');
      const segmentCount = playlist.split(/\r?\n/).filter((line) => line && !line.startsWith('#')).length;
      return segmentCount >= samsungInitialSegmentCount || playlist.includes('#EXT-X-ENDLIST') ? playlist : undefined;
    } catch { return undefined; }
  }

  async playlist(sessionId: string, source: NormalizedSource, mode: AdaptMode, subtitleSrt?: string): Promise<string> {
    const playlist = this.playlistPath(sessionId);
    const existing = await this.initialPlaylist(playlist);
    if (existing) return existing;
    if (!this.active.has(sessionId)) await this.start(sessionId, source, mode, subtitleSrt);
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const ready = await this.initialPlaylist(playlist);
      if (ready) return ready;
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
    throw new Error('adaptation startup timed out');
  }

  async segment(sessionId: string, fileName: string): Promise<{ path: string; contentType: string }> {
    if (!/^[A-Za-z0-9._-]+\.(?:ts|m4s|aac)$/.test(fileName)) throw new Error('invalid adaptation segment');
    const directory = this.directory(sessionId);
    const path = resolve(directory, fileName);
    if (!path.startsWith(`${directory}/`)) throw new Error('invalid adaptation segment');
    await stat(path);
    return { path, contentType: fileName.endsWith('.m4s') ? 'video/iso.segment' : fileName.endsWith('.aac') ? 'audio/aac' : 'video/mp2t' };
  }

  private async start(sessionId: string, source: NormalizedSource, mode: AdaptMode, subtitleSrt?: string): Promise<void> {
    await assertSafeUpstreamUrl(source.url);
    const directory = this.directory(sessionId);
    await mkdir(directory, { recursive: true });
    const output = this.playlistPath(sessionId);
    const subtitlePath = join(directory, 'burned.srt');
    if (subtitleSrt) await writeFile(subtitlePath, subtitleSrt, 'utf8');
    const headers = Object.entries(source.headers ?? {})
      .filter(([key, value]) => /^[A-Za-z-]{1,64}$/.test(key) && !/[\r\n]/.test(value))
      .map(([key, value]) => `${key}: ${value}\r\n`).join('');
    const isTranscode = mode === 'transcode' || Boolean(subtitleSrt);
    if (isTranscode && this.activeTranscode && this.activeTranscode !== sessionId) {
      const previousId = this.activeTranscode;
      // This bridge targets one television. A new selection must replace an
      // abandoned conversion instead of being rejected until the old VOD ends.
      this.active.get(previousId)?.kill('SIGKILL');
      this.active.delete(previousId);
      this.activeTranscode = undefined;
    }
    const common = ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-threads', '3', ...(headers ? ['-headers', headers] : []), '-readrate', samsungInputReadRate, '-i', source.url, '-map', '0:v:0?', '-map', '0:a:0?', '-sn'];
    const conversion = mode === 'remux' && !subtitleSrt
      ? ['-c:v', 'copy', '-c:a', 'copy']
      : ['-vf', samsungScaleFilter, '-r', '30', '-g', '120', '-sc_threshold', '0', '-c:v', 'libx264', '-profile:v', 'high', '-level:v', '4.1', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-b:v', '2800k', '-maxrate', '3200k', '-bufsize', '5600k', '-c:a', 'aac', '-ac', '2', '-b:a', '128k'];
    if (subtitleSrt) conversion[1] = `subtitles=${subtitlePath},${samsungScaleFilter}`;
    const args = [...common, ...conversion, '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0', '-hls_flags', samsungHlsFlags, '-hls_segment_filename', join(directory, 'segment-%05d.ts'), output];
    const child = spawn(this.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    this.active.set(sessionId, child);
    if (isTranscode) this.activeTranscode = sessionId;
    let errorLog = '';
    child.stderr.on('data', (chunk) => { errorLog = `${errorLog}${String(chunk)}`.slice(-2000); });
    child.on('error', () => { this.active.delete(sessionId); if (this.activeTranscode === sessionId) this.activeTranscode = undefined; });
    child.on('close', (code) => {
      this.active.delete(sessionId);
      if (this.activeTranscode === sessionId) this.activeTranscode = undefined;
      if (code && code !== 0) console.warn(`FFmpeg adaptation ${sessionId} exited ${code}: ${errorLog}`);
    });
  }
}
