import assert from 'node:assert/strict';
import test from 'node:test';
import { samsungHlsFlags, samsungInitialSegmentCount, samsungInputReadRate, samsungScaleFilter } from '../adapt.js';

test('preserves the escaped FFmpeg expression comma', () => {
  assert.equal(samsungScaleFilter, 'scale=w=min(1280\\,iw):h=-2:force_original_aspect_ratio=decrease');
  assert.ok(samsungScaleFilter.includes('\\,'));
});

test('does not emit the unsupported Tizen 3 independent-segments tag', () => {
  assert.equal(samsungHlsFlags, 'temp_file');
  assert.doesNotMatch(samsungHlsFlags, /independent_segments/);
});

test('paces the growing HLS playlist at real-time speed', () => {
  assert.equal(samsungInputReadRate, '1');
  assert.equal(samsungInitialSegmentCount, 3);
});
