import assert from 'node:assert/strict';
import test from 'node:test';
import { safeDefaultProfile } from '../db.js';

test('Samsung 2017 defaults use native soft SRT with burn-in available as a fallback', () => {
  assert.equal(safeDefaultProfile.supportsSrt, true);
  assert.equal(safeDefaultProfile.subtitleMode, 'soft');
  assert.equal(safeDefaultProfile.subtitleMaxHeight, 1080);
  assert.equal(safeDefaultProfile.preferredBufferSeconds, 10);
});
