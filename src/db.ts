import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ContentItem, DeviceProfile, NormalizedSource, PlaybackPlan, SubtitleCandidate } from './types.js';
import { sha256 } from './security.js';

const safeDefaultProfile: DeviceProfile = {
  maxHeight: 1080,
  maxFps: 30,
  maxBitrate: 8_000_000,
  supportsHls: true,
  supportsMp4: true,
  supportsMkv: false,
  supportsH264: true,
  supportsHevc: false,
  supportsAac: true,
  supportsAc3: false,
  // MSX 0.1.141+ downloads remote SRT tracks for Samsung AVPlay. Keep the
  // native hardware decoder on the fast path and retain burn-in as a fallback.
  supportsSrt: true,
  preferredBufferSeconds: 10,
  subtitleMode: 'soft',
  subtitleMaxHeight: 1080
};

type Row = Record<string, unknown>;

export class Store {
  readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'msxbridge.sqlite'));
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER,
        profile_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS playback_sessions (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL REFERENCES devices(id),
        content_id TEXT NOT NULL,
        source_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS content_records (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        provider_ref TEXT NOT NULL,
        content_json TEXT NOT NULL,
        details_json TEXT,
        catalog_expires_at INTEGER NOT NULL,
        details_expires_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS watch_progress (
        device_id TEXT NOT NULL REFERENCES devices(id),
        content_id TEXT NOT NULL,
        position_seconds INTEGER NOT NULL,
        duration_seconds INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(device_id, content_id)
      );
      CREATE TABLE IF NOT EXISTS addon_configs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('stremio', 'cloudstream')),
        url TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plugin_records (
        sha256 TEXT PRIMARY KEY,
        file_name TEXT NOT NULL,
        trust_state TEXT NOT NULL CHECK(trust_state IN ('DOWNLOADED', 'INSPECTED', 'TESTED', 'AUTHORIZED', 'ENABLED', 'PENDING_REVIEW', 'QUARANTINED')),
        successful_executions INTEGER NOT NULL DEFAULT 0,
        failed_executions INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS device_diagnostics (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL REFERENCES devices(id),
        test_key TEXT NOT NULL,
        passed INTEGER NOT NULL,
        notes TEXT,
        observed_json TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON playback_sessions(expires_at);
      CREATE INDEX IF NOT EXISTS idx_progress_updated ON watch_progress(device_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_plugins_file ON plugin_records(file_name, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_diagnostics_device ON device_diagnostics(device_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_content_provider_ref ON content_records(provider, provider_ref);
      CREATE INDEX IF NOT EXISTS idx_content_catalog_expiry ON content_records(catalog_expires_at);
    `);
    // SQLite has no ADD COLUMN IF NOT EXISTS. These migrations are intentionally
    // additive so a deployed playback database remains recoverable.
    for (const statement of [
      `ALTER TABLE playback_sessions ADD COLUMN plan_json TEXT`,
      `ALTER TABLE playback_sessions ADD COLUMN subtitle_json TEXT`,
      `ALTER TABLE playback_sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`,
      `ALTER TABLE playback_sessions ADD COLUMN cleanup_at INTEGER`
    ]) {
      try { this.db.exec(statement); } catch { /* already applied */ }
    }
    this.migrateSamsungProfiles();
  }

  private migrateSamsungProfiles(): void {
    const rows = this.db.prepare(`SELECT id, profile_json FROM devices WHERE revoked_at IS NULL`).all() as Row[];
    const update = this.db.prepare(`UPDATE devices SET profile_json = ? WHERE id = ?`);
    for (const row of rows) {
      try {
        const old = JSON.parse(String(row.profile_json)) as Partial<DeviceProfile>;
        const profile: DeviceProfile = { ...safeDefaultProfile, ...old, supportsSrt: true, subtitleMode: 'soft', subtitleMaxHeight: 1080, preferredBufferSeconds: 10 };
        update.run(JSON.stringify(profile), String(row.id));
      } catch { /* leave malformed legacy rows for explicit administrator repair */ }
    }
  }

  close(): void { this.db.close(); }

  createDevice(id: string, name: string, token: string, profile: DeviceProfile = safeDefaultProfile): void {
    this.db.prepare(`INSERT INTO devices(id, name, token_hash, created_at, profile_json) VALUES (?, ?, ?, ?, ?)`)
      .run(id, name, sha256(token), Date.now(), JSON.stringify(profile));
  }

  ensureDevice(id: string, name: string, token: string, profile: DeviceProfile = safeDefaultProfile): { id: string; name: string; profile: DeviceProfile } {
    const existing = this.getDeviceByToken(token);
    if (existing) return existing;
    this.createDevice(id, name, token, profile);
    return { id, name, profile };
  }

  getDeviceByToken(token: string): { id: string; name: string; profile: DeviceProfile } | undefined {
    const row = this.db.prepare(`SELECT id, name, profile_json FROM devices WHERE token_hash = ? AND revoked_at IS NULL`).get(sha256(token)) as Row | undefined;
    if (!row) return undefined;
    return { id: String(row.id), name: String(row.name), profile: JSON.parse(String(row.profile_json)) as DeviceProfile };
  }

  listDevices(): Array<{ id: string; name: string; createdAt: number; revokedAt?: number; profile: DeviceProfile }> {
    return (this.db.prepare(`SELECT id, name, created_at, revoked_at, profile_json FROM devices ORDER BY created_at DESC`).all() as Row[])
      .map((row) => ({ id: String(row.id), name: String(row.name), createdAt: Number(row.created_at), revokedAt: row.revoked_at == null ? undefined : Number(row.revoked_at), profile: JSON.parse(String(row.profile_json)) as DeviceProfile }));
  }

  updateProfile(deviceId: string, profile: DeviceProfile): void {
    this.db.prepare(`UPDATE devices SET profile_json = ? WHERE id = ? AND revoked_at IS NULL`).run(JSON.stringify({ ...safeDefaultProfile, ...profile }), deviceId);
  }

  revokeDevice(deviceId: string): void {
    this.db.prepare(`UPDATE devices SET revoked_at = ? WHERE id = ?`).run(Date.now(), deviceId);
  }

  addAddon(id: string, type: 'stremio' | 'cloudstream', url: string): void {
    this.db.prepare(`INSERT INTO addon_configs(id, type, url, enabled, created_at) VALUES (?, ?, ?, 1, ?)`)
      .run(id, type, url, Date.now());
  }

  listAddons(type?: 'stremio' | 'cloudstream'): Array<{ id: string; type: 'stremio' | 'cloudstream'; url: string; enabled: boolean; createdAt: number }> {
    const statement = type
      ? this.db.prepare(`SELECT id, type, url, enabled, created_at FROM addon_configs WHERE type = ? ORDER BY created_at DESC`)
      : this.db.prepare(`SELECT id, type, url, enabled, created_at FROM addon_configs ORDER BY created_at DESC`);
    const rows = (type ? statement.all(type) : statement.all()) as Row[];
    return rows.map((row) => ({ id: String(row.id), type: String(row.type) as 'stremio' | 'cloudstream', url: String(row.url), enabled: Number(row.enabled) === 1, createdAt: Number(row.created_at) }));
  }

  setAddonEnabled(id: string, enabled: boolean): void {
    this.db.prepare(`UPDATE addon_configs SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id);
  }

  upsertPlugin(sha256: string, fileName: string, trustState: 'DOWNLOADED' | 'INSPECTED' | 'TESTED' | 'AUTHORIZED' | 'ENABLED' | 'PENDING_REVIEW' | 'QUARANTINED' = 'INSPECTED'): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO plugin_records(sha256, file_name, trust_state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(sha256) DO UPDATE SET file_name = excluded.file_name, updated_at = excluded.updated_at
    `).run(sha256, fileName, trustState, now, now);
  }

  listPlugins(): Array<{ sha256: string; fileName: string; trustState: string; successfulExecutions: number; failedExecutions: number; lastError?: string; updatedAt: number }> {
    return (this.db.prepare(`SELECT sha256, file_name, trust_state, successful_executions, failed_executions, last_error, updated_at FROM plugin_records ORDER BY updated_at DESC`).all() as Row[])
      .map((row) => ({ sha256: String(row.sha256), fileName: String(row.file_name), trustState: String(row.trust_state), successfulExecutions: Number(row.successful_executions), failedExecutions: Number(row.failed_executions), lastError: row.last_error == null ? undefined : String(row.last_error), updatedAt: Number(row.updated_at) }));
  }

  setPluginTrustState(sha256: string, trustState: 'TESTED' | 'AUTHORIZED' | 'ENABLED' | 'PENDING_REVIEW' | 'QUARANTINED'): void {
    this.db.prepare(`UPDATE plugin_records SET trust_state = ?, updated_at = ? WHERE sha256 = ?`).run(trustState, Date.now(), sha256);
  }

  recordPluginExecution(sha256: string, success: boolean, error?: string): void {
    if (success) {
      this.db.prepare(`UPDATE plugin_records SET successful_executions = successful_executions + 1, trust_state = CASE WHEN trust_state = 'INSPECTED' THEN 'TESTED' ELSE trust_state END, updated_at = ? WHERE sha256 = ?`).run(Date.now(), sha256);
      return;
    }
    this.db.prepare(`UPDATE plugin_records SET failed_executions = failed_executions + 1, last_error = ?, trust_state = CASE WHEN failed_executions + 1 >= 3 THEN 'QUARANTINED' ELSE trust_state END, updated_at = ? WHERE sha256 = ?`).run((error ?? 'execution failed').slice(0, 500), Date.now(), sha256);
  }

  saveDiagnostic(id: string, deviceId: string, testKey: string, passed: boolean, notes?: string, observed?: unknown): void {
    this.db.prepare(`INSERT INTO device_diagnostics(id, device_id, test_key, passed, notes, observed_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, deviceId, testKey, passed ? 1 : 0, notes?.slice(0, 1000) ?? null, observed === undefined ? null : JSON.stringify(observed), Date.now());
  }

  listDiagnostics(deviceId: string): Array<{ testKey: string; passed: boolean; notes?: string; observed?: unknown; createdAt: number }> {
    return (this.db.prepare(`SELECT test_key, passed, notes, observed_json, created_at FROM device_diagnostics WHERE device_id = ? ORDER BY created_at DESC`).all(deviceId) as Row[])
      .map((row) => ({ testKey: String(row.test_key), passed: Number(row.passed) === 1, notes: row.notes == null ? undefined : String(row.notes), observed: row.observed_json == null ? undefined : JSON.parse(String(row.observed_json)), createdAt: Number(row.created_at) }));
  }

  createPlaybackSession(id: string, deviceId: string, contentId: string, source: NormalizedSource, expiresAt: number, plan?: PlaybackPlan, subtitle?: SubtitleCandidate): void {
    const now = Date.now();
    this.db.prepare(`INSERT INTO playback_sessions(id, device_id, content_id, source_json, created_at, expires_at, plan_json, subtitle_json, status, cleanup_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`)
      .run(id, deviceId, contentId, JSON.stringify(source), now, expiresAt, plan ? JSON.stringify(plan) : null, subtitle ? JSON.stringify(subtitle) : null, expiresAt + 60 * 60 * 1000);
  }

  getPlaybackSession(id: string): { id: string; deviceId: string; contentId: string; source: NormalizedSource; expiresAt: number; plan?: PlaybackPlan; subtitle?: SubtitleCandidate } | undefined {
    const row = this.db.prepare(`SELECT id, device_id, content_id, source_json, expires_at, plan_json, subtitle_json FROM playback_sessions WHERE id = ?`).get(id) as Row | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id), deviceId: String(row.device_id), contentId: String(row.content_id), source: JSON.parse(String(row.source_json)) as NormalizedSource, expiresAt: Number(row.expires_at),
      plan: row.plan_json == null ? undefined : JSON.parse(String(row.plan_json)) as PlaybackPlan,
      subtitle: row.subtitle_json == null ? undefined : JSON.parse(String(row.subtitle_json)) as SubtitleCandidate
    };
  }

  deleteExpiredSessions(now = Date.now()): number {
    return Number(this.db.prepare(`DELETE FROM playback_sessions WHERE expires_at < ?`).run(now).changes);
  }

  saveProgress(deviceId: string, contentId: string, positionSeconds: number, durationSeconds?: number): void {
    this.db.prepare(`
      INSERT INTO watch_progress(device_id, content_id, position_seconds, duration_seconds, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(device_id, content_id) DO UPDATE SET
        position_seconds = excluded.position_seconds,
        duration_seconds = excluded.duration_seconds,
        updated_at = excluded.updated_at
    `).run(deviceId, contentId, positionSeconds, durationSeconds ?? null, Date.now());
  }

  getProgress(deviceId: string, contentId: string): { positionSeconds: number; durationSeconds?: number } | undefined {
    const row = this.db.prepare(`SELECT position_seconds, duration_seconds FROM watch_progress WHERE device_id = ? AND content_id = ?`).get(deviceId, contentId) as Row | undefined;
    return row ? { positionSeconds: Number(row.position_seconds), durationSeconds: row.duration_seconds == null ? undefined : Number(row.duration_seconds) } : undefined;
  }

  upsertContent(item: ContentItem, ttlMs = 10 * 60 * 1000): void {
    if (!item.provider || !item.providerRef) return;
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO content_records(id, provider, provider_ref, content_json, catalog_expires_at, details_expires_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, ?)
      ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, provider_ref = excluded.provider_ref, content_json = excluded.content_json, catalog_expires_at = excluded.catalog_expires_at, updated_at = excluded.updated_at
    `).run(item.id, item.provider, item.providerRef, JSON.stringify(item), now + ttlMs, now);
  }

  saveDetails(item: ContentItem, details: unknown, ttlMs = 6 * 60 * 60 * 1000): void {
    this.upsertContent(item);
    this.db.prepare(`UPDATE content_records SET details_json = ?, details_expires_at = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(details), Date.now() + ttlMs, Date.now(), item.id);
  }

  getContent(id: string): ContentItem | undefined {
    const row = this.db.prepare(`SELECT content_json FROM content_records WHERE id = ?`).get(id) as Row | undefined;
    return row ? JSON.parse(String(row.content_json)) as ContentItem : undefined;
  }

  getDetails(id: string): unknown | undefined {
    const row = this.db.prepare(`SELECT details_json FROM content_records WHERE id = ? AND details_json IS NOT NULL`).get(id) as Row | undefined;
    return row ? JSON.parse(String(row.details_json)) : undefined;
  }

  getRecentContent(limit = 48): ContentItem[] {
    return (this.db.prepare(`SELECT content_json FROM content_records ORDER BY updated_at DESC LIMIT ?`).all(limit) as Row[])
      .map((row) => JSON.parse(String(row.content_json)) as ContentItem);
  }
}

export { safeDefaultProfile };
