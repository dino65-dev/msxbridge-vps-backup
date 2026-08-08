import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSubtitle } from '../subtitles.js';

test('normalizes SRT numbering, BOM and line endings', () => {
  const value = normalizeSubtitle('\uFEFF9\r\n00:00:01,000 --> 00:00:02,500\r\nHello\r\n', 'srt');
  assert.equal(value, '1\n00:00:01,000 --> 00:00:02,500\nHello\n');
});

test('converts WebVTT cues and removes cue settings and voice tags', () => {
  const value = normalizeSubtitle('WEBVTT\n\nintro\n00:01.250 --> 00:03.000 align:start\n<v Speaker>Hello</v>\n', 'vtt');
  assert.equal(value, '1\n00:00:01,250 --> 00:00:03,000\nHello\n');
});

test('converts ASS dialogue text to SRT', () => {
  const value = normalizeSubtitle('[Script Info]\nTitle: Test\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,{\\i1}Hello{\\i0}\\NWorld\n', 'ass');
  assert.equal(value, '1\n00:00:01,000 --> 00:00:03,500\nHello\nWorld\n');
});

test('applies fixed timing offsets and clamps negative starts', () => {
  assert.equal(normalizeSubtitle('1\n00:00:01,000 --> 00:00:03,000\nHello\n', 'srt', -1500), '1\n00:00:00,000 --> 00:00:01,500\nHello\n');
  assert.equal(normalizeSubtitle('1\n00:00:01,000 --> 00:00:03,000\nHello\n', 'srt', 500), '1\n00:00:01,500 --> 00:00:03,500\nHello\n');
});

test('rejects malformed or empty subtitle payloads', () => {
  assert.throws(() => normalizeSubtitle('not a subtitle', 'srt'), /no_valid_cues/);
  assert.throws(() => normalizeSubtitle('1\n00:00:01,000 --> 00:00:03,000\nHello\n', 'srt', 50_000), /invalid_subtitle_delay/);
});
