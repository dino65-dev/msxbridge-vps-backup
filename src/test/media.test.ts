import assert from 'node:assert/strict';
import test from 'node:test';
import { rewriteHlsPlaylist } from '../media.js';

test('rewrites HLS segment and URI attributes through the signed proxy', () => {
  const result = rewriteHlsPlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\nvariant.m3u8', 'https://media.example/path/master.m3u8', 'https://bridge.example/play/sig/segment?expires=1');
  assert.match(result, /url=https%3A%2F%2Fmedia.example%2Fpath%2Fkey.bin/);
  assert.match(result, /url=https%3A%2F%2Fmedia.example%2Fpath%2Fvariant.m3u8/);
});
