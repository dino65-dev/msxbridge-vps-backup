import type { SubtitleCandidate } from './types.js';
import { assertSafeUpstreamUrl } from './security.js';

const maxSubtitleBytes = 2 * 1024 * 1024;
const maxRedirects = 3;
const subtitleCacheTtlMs = 5 * 60 * 1000;
const subtitleCache = new Map<string, { expiresAt: number; value: Promise<string> }>();

function pad(value: number, width: number): string { return String(value).padStart(width, '0'); }

function parseTimestamp(value: string): number | undefined {
  const match = value.trim().match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[,.](\d{1,3})$/);
  if (!match) return undefined;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const milliseconds = Number(match[4].padEnd(3, '0'));
  if (minutes > 59 || seconds > 59) return undefined;
  return (((hours * 60 + minutes) * 60 + seconds) * 1000) + milliseconds;
}

function parseAssTimestamp(value: string): number | undefined {
  const match = value.trim().match(/^(\d+):(\d{2}):(\d{2})[.](\d{1,2})$/);
  if (!match) return undefined;
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (minutes > 59 || seconds > 59) return undefined;
  return (((Number(match[1]) * 60 + minutes) * 60 + seconds) * 1000) + Number(match[4].padEnd(2, '0')) * 10;
}

function formatTimestamp(value: number): string {
  const safe = Math.max(0, Math.round(value));
  const hours = Math.floor(safe / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1000);
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(safe % 1000, 3)}`;
}

interface Cue { start: number; end: number; text: string }

function renderSrt(cues: Cue[], delayMs = 0): string {
  const shifted = cues.flatMap((cue) => {
    const start = Math.max(0, cue.start + delayMs);
    const end = cue.end + delayMs;
    return end > start && cue.text.trim() ? [{ ...cue, start, end }] : [];
  });
  if (!shifted.length) throw new Error('subtitle_has_no_valid_cues');
  return `${shifted.map((cue, index) => `${index + 1}\n${formatTimestamp(cue.start)} --> ${formatTimestamp(cue.end)}\n${cue.text.trim()}`).join('\n\n')}\n`;
}

function parseSrt(input: string): Cue[] {
  const normalized = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  const cues: Cue[] = [];
  for (const block of normalized.split(/\n{2,}/)) {
    const lines = block.split('\n');
    if (/^\d+$/.test(lines[0]?.trim() ?? '')) lines.shift();
    const timing = lines.shift()?.match(/^\s*(\S+)\s*-->\s*(\S+)/);
    if (!timing) continue;
    const start = parseTimestamp(timing[1]);
    const end = parseTimestamp(timing[2]);
    if (start === undefined || end === undefined || end <= start) continue;
    cues.push({ start, end, text: lines.join('\n').trim() });
  }
  return cues;
}

function parseVtt(input: string): Cue[] {
  const normalized = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  const blocks = normalized.replace(/^WEBVTT[^\n]*\n?/, '').trim().split(/\n{2,}/);
  const cues: Cue[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    if (/^(NOTE|STYLE|REGION)(?:\s|$)/.test(lines[0]?.trim() ?? '')) continue;
    if (!lines[0]?.includes('-->')) lines.shift();
    const timing = lines.shift()?.match(/^\s*(\S+)\s*-->\s*(\S+)/);
    if (!timing) continue;
    const start = parseTimestamp(timing[1]);
    const end = parseTimestamp(timing[2]);
    if (start === undefined || end === undefined || end <= start) continue;
    const text = lines.join('\n')
      .replace(/<\/?(?:c(?:\.[^ >]+)?|v(?:\s+[^>]+)?|lang(?:\s+[^>]+)?|ruby|rt|b|i|u)>/gi, '')
      .trim();
    cues.push({ start, end, text });
  }
  return cues;
}

function parseAss(input: string): Cue[] {
  const lines = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  let inEvents = false;
  let format: string[] = [];
  const cues: Cue[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[Events\]$/i.test(trimmed)) { inEvents = true; continue; }
    if (/^\[.+\]$/.test(trimmed)) { inEvents = false; continue; }
    if (!inEvents) continue;
    if (/^Format\s*:/i.test(trimmed)) {
      format = trimmed.replace(/^Format\s*:/i, '').split(',').map((field) => field.trim().toLowerCase());
      continue;
    }
    if (!/^Dialogue\s*:/i.test(trimmed) || !format.length) continue;
    const values = trimmed.replace(/^Dialogue\s*:/i, '').split(',');
    if (values.length < format.length) continue;
    const textIndex = format.indexOf('text');
    const startIndex = format.indexOf('start');
    const endIndex = format.indexOf('end');
    if (textIndex < 0 || startIndex < 0 || endIndex < 0) continue;
    const fields = values.slice(0, format.length - 1);
    fields.push(values.slice(format.length - 1).join(','));
    const start = parseAssTimestamp(fields[startIndex]);
    const end = parseAssTimestamp(fields[endIndex]);
    if (start === undefined || end === undefined || end <= start) continue;
    const text = fields[textIndex].replace(/\{[^}]*\}/g, '').replace(/\\[Nn]/g, '\n').replace(/\\h/g, ' ').trim();
    cues.push({ start, end, text });
  }
  return cues;
}

export function normalizeSubtitle(input: string, format: SubtitleCandidate['format'], delayMs = 0): string {
  if (!Number.isSafeInteger(delayMs) || Math.abs(delayMs) > 10_000) throw new Error('invalid_subtitle_delay');
  const detected = format === 'unknown'
    ? /^WEBVTT/m.test(input) ? 'vtt' : /^\[Script Info\]/mi.test(input) || /^\[Events\]/mi.test(input) ? 'ass' : 'srt'
    : format;
  const cues = detected === 'vtt' ? parseVtt(input) : detected === 'ass' ? parseAss(input) : parseSrt(input);
  return renderSrt(cues, delayMs);
}

async function boundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > maxSubtitleBytes) throw new Error('subtitle_payload_too_large');
  if (!response.body) throw new Error('empty_subtitle_payload');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxSubtitleBytes) { await reader.cancel(); throw new Error('subtitle_payload_too_large'); }
    chunks.push(value);
  }
  if (!size) throw new Error('empty_subtitle_payload');
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchSubtitle(urlValue: string): Promise<string> {
  let url = await assertSafeUpstreamUrl(urlValue);
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(12_000), headers: { accept: 'application/x-subrip,text/vtt,text/plain;q=0.9,*/*;q=0.1' } });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location || redirects === maxRedirects) throw new Error('subtitle_redirect_rejected');
      url = await assertSafeUpstreamUrl(new URL(location, url).toString());
      continue;
    }
    if (!response.ok) throw new Error(`subtitle_fetch_failed_${response.status}`);
    return boundedText(response);
  }
  throw new Error('subtitle_redirect_rejected');
}

export async function fetchSubtitleSrt(candidate: SubtitleCandidate, delayMs = 0): Promise<string> {
  const key = `${candidate.format}:${candidate.url}`;
  let cached = subtitleCache.get(key);
  if (!cached || cached.expiresAt <= Date.now()) {
    if (subtitleCache.size >= 64) subtitleCache.delete(subtitleCache.keys().next().value ?? '');
    const value = fetchSubtitle(candidate.url).then((text) => normalizeSubtitle(text, candidate.format));
    cached = { expiresAt: Date.now() + subtitleCacheTtlMs, value };
    subtitleCache.set(key, cached);
    void value.catch(() => { if (subtitleCache.get(key)?.value === value) subtitleCache.delete(key); });
  }
  const srt = await cached.value;
  return delayMs ? normalizeSubtitle(srt, 'srt', delayMs) : srt;
}
