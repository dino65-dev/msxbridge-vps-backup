import assert from 'node:assert/strict';
import test from 'node:test';
import { safeDefaultProfile } from '../db.js';
import { rankSource } from '../ranker.js';

test('ranks a safe H.264/AAC HLS source for direct play', () => {
  const ranked = rankSource({
    sourceId: 'safe', provider: 'test', url: 'https://media.example/safe.m3u8', protocol: 'hls', container: 'mpegts',
    videoCodec: 'h264', audioCodec: 'aac', height: 1080, fps: 30, bitrate: 6_000_000
  }, safeDefaultProfile);
  assert.equal(ranked.decision, 'direct');
  assert.ok(ranked.score > 100);
});

test('requires transcode for unsupported codecs', () => {
  const ranked = rankSource({
    sourceId: 'av1', provider: 'test', url: 'https://media.example/av1.mp4', protocol: 'mp4', container: 'mp4',
    videoCodec: 'av1', audioCodec: 'opus', height: 1080, fps: 30
  }, safeDefaultProfile);
  assert.equal(ranked.decision, 'transcode');
  assert.match(ranked.reasons.join(' '), /requires video transcode/);
});
