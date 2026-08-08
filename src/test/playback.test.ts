import test from 'node:test';
import assert from 'node:assert/strict';
import { planSamsung2017Playback } from '../playback.js';
import { safeDefaultProfile } from '../db.js';

test('plans MKV H.264/AAC as a remux for the Samsung 2017 profile', () => {
  const plan = planSamsung2017Playback({
    sourceId: 'mkv-copy', provider: 'test', url: 'https://media.example/video.mkv', protocol: 'file', container: 'mkv', videoCodec: 'h264', audioCodec: 'aac', height: 1080
  }, safeDefaultProfile);
  assert.equal(plan.mode, 'remux');
  assert.match(plan.reason, /Container requires remux/);
});

test('plans AV1 as a Samsung-safe transcode fallback', () => {
  const plan = planSamsung2017Playback({
    sourceId: 'av1', provider: 'test', url: 'https://media.example/video.mp4', protocol: 'mp4', container: 'mp4', videoCodec: 'av1', audioCodec: 'aac', height: 1080
  }, safeDefaultProfile);
  assert.equal(plan.mode, 'transcode');
  assert.match(plan.reason, /requires video transcode/);
});
