import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";

export interface PairSessionRow {
  pairId: string;
  codeHash: string;
  expiresAt: number;
  usedAt: number | null;
}

export interface RefreshTokenRow {
  id: string;
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  deviceId: string;
  deviceName: string;
}

export interface ThreadNameRow {
  threadId: string;
  name: string;
  updatedAt: number;
}

export interface ThreadCwdRow {
  threadId: string;
  cwd: string;
  updatedAt: number;
}

export interface ThreadEventRow {
  id: number;
  threadId: string;
  method: string;
  paramsJson: string;
  createdAt: number;
}

interface SettingsRow {
  id: number;
  jwtSecret: string;
  createdAt: number;
}

export class GatewayDatabase {
  private readonly db: Database.Database;

  constructor(filePath: string) {
    const parent = path.dirname(filePath);
    fs.mkdirSync(parent, { recursive: true });
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.init();
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pair_sessions (
        pairId TEXT PRIMARY KEY,
        codeHash TEXT NOT NULL,
        expiresAt INTEGER NOT NULL,
        usedAt INTEGER NULL
      );

      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id TEXT PRIMARY KEY,
        tokenHash TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        expiresAt INTEGER NOT NULL,
        revokedAt INTEGER NULL,
        deviceId TEXT NOT NULL,
        deviceName TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        jwtSecret TEXT NOT NULL,
        createdAt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS thread_names (
        threadId TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        updatedAt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS thread_cwds (
        threadId TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        updatedAt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS thread_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        threadId TEXT NOT NULL,
        method TEXT NOT NULL,
        paramsJson TEXT NOT NULL,
        createdAt INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_pair_expires ON pair_sessions (expiresAt);
      CREATE INDEX IF NOT EXISTS idx_refresh_expires ON refresh_tokens (expiresAt);
      CREATE INDEX IF NOT EXISTS idx_refresh_revoked ON refresh_tokens (revokedAt);
      CREATE INDEX IF NOT EXISTS idx_thread_names_updated ON thread_names (updatedAt);
      CREATE INDEX IF NOT EXISTS idx_thread_cwds_updated ON thread_cwds (updatedAt);
      CREATE INDEX IF NOT EXISTS idx_thread_events_thread_created ON thread_events (threadId, createdAt);
    `);
  }

  close() {
    this.db.close();
  }

  getOrCreateJwtSecret(): string {
    const row = this.db.prepare("SELECT id, jwtSecret, createdAt FROM settings WHERE id = 1").get() as
      | SettingsRow
      | undefined;

    if (row?.jwtSecret) {
      return row.jwtSecret;
    }

    const secret = randomBytes(48).toString("base64url");
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO settings (id, jwtSecret, createdAt) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET jwtSecret = excluded.jwtSecret"
      )
      .run(secret, now);
    return secret;
  }

  insertPairSession(session: PairSessionRow) {
    this.db
      .prepare("INSERT INTO pair_sessions (pairId, codeHash, expiresAt, usedAt) VALUES (?, ?, ?, ?)")
      .run(session.pairId, session.codeHash, session.expiresAt, session.usedAt);
  }

  getPairSession(pairId: string): PairSessionRow | null {
    const row = this.db
      .prepare("SELECT pairId, codeHash, expiresAt, usedAt FROM pair_sessions WHERE pairId = ?")
      .get(pairId) as PairSessionRow | undefined;
    return row ?? null;
  }

  markPairSessionUsed(pairId: string, usedAt: number) {
    this.db.prepare("UPDATE pair_sessions SET usedAt = ? WHERE pairId = ?").run(usedAt, pairId);
  }

  cleanupPairSessions(now: number) {
    this.db.prepare("DELETE FROM pair_sessions WHERE expiresAt < ? OR usedAt IS NOT NULL").run(now);
  }

  insertRefreshToken(token: RefreshTokenRow) {
    this.db
      .prepare(
        `INSERT INTO refresh_tokens (id, tokenHash, createdAt, expiresAt, revokedAt, deviceId, deviceName)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(token.id, token.tokenHash, token.createdAt, token.expiresAt, token.revokedAt, token.deviceId, token.deviceName);
  }

  getRefreshToken(id: string): RefreshTokenRow | null {
    const row = this.db
      .prepare(
        "SELECT id, tokenHash, createdAt, expiresAt, revokedAt, deviceId, deviceName FROM refresh_tokens WHERE id = ?"
      )
      .get(id) as RefreshTokenRow | undefined;
    return row ?? null;
  }

  revokeRefreshToken(id: string, revokedAt: number) {
    this.db.prepare("UPDATE refresh_tokens SET revokedAt = ? WHERE id = ?").run(revokedAt, id);
  }

  cleanupRefreshTokens() {
    this.db.prepare("DELETE FROM refresh_tokens WHERE revokedAt IS NOT NULL").run();
  }

  listActiveDevices(): Array<Pick<RefreshTokenRow, "id" | "deviceId" | "deviceName" | "createdAt" | "expiresAt">> {
    return this.db
      .prepare(
        `SELECT id, deviceId, deviceName, createdAt, expiresAt
         FROM refresh_tokens
         WHERE revokedAt IS NULL
         ORDER BY createdAt DESC`
      )
      .all() as Array<Pick<RefreshTokenRow, "id" | "deviceId" | "deviceName" | "createdAt" | "expiresAt">>;
  }

  upsertThreadName(threadName: ThreadNameRow) {
    this.db
      .prepare(
        `INSERT INTO thread_names (threadId, name, updatedAt)
         VALUES (?, ?, ?)
         ON CONFLICT(threadId) DO UPDATE SET
           name = excluded.name,
           updatedAt = excluded.updatedAt`
      )
      .run(threadName.threadId, threadName.name, threadName.updatedAt);
  }

  getThreadName(threadId: string): ThreadNameRow | null {
    const row = this.db
      .prepare("SELECT threadId, name, updatedAt FROM thread_names WHERE threadId = ?")
      .get(threadId) as ThreadNameRow | undefined;
    return row ?? null;
  }

  getThreadNames(threadIds: string[]): Map<string, ThreadNameRow> {
    const result = new Map<string, ThreadNameRow>();
    for (const threadId of threadIds) {
      const row = this.getThreadName(threadId);
      if (row) {
        result.set(threadId, row);
      }
    }
    return result;
  }

  upsertThreadCwd(threadCwd: ThreadCwdRow) {
    this.db
      .prepare(
        `INSERT INTO thread_cwds (threadId, cwd, updatedAt)
         VALUES (?, ?, ?)
         ON CONFLICT(threadId) DO UPDATE SET
           cwd = excluded.cwd,
           updatedAt = excluded.updatedAt`
      )
      .run(threadCwd.threadId, threadCwd.cwd, threadCwd.updatedAt);
  }

  getThreadCwd(threadId: string): ThreadCwdRow | null {
    const row = this.db
      .prepare("SELECT threadId, cwd, updatedAt FROM thread_cwds WHERE threadId = ?")
      .get(threadId) as ThreadCwdRow | undefined;
    return row ?? null;
  }

  getThreadCwds(threadIds: string[]): Map<string, ThreadCwdRow> {
    const result = new Map<string, ThreadCwdRow>();
    for (const threadId of threadIds) {
      const row = this.getThreadCwd(threadId);
      if (row) {
        result.set(threadId, row);
      }
    }
    return result;
  }

  insertThreadEvent(threadId: string, method: string, paramsJson: string, createdAt: number) {
    this.db
      .prepare("INSERT INTO thread_events (threadId, method, paramsJson, createdAt) VALUES (?, ?, ?, ?)")
      .run(threadId, method, paramsJson, createdAt);
  }

  listThreadEvents(threadId: string, limit = 500): ThreadEventRow[] {
    return this.db
      .prepare(
        `SELECT id, threadId, method, paramsJson, createdAt
         FROM thread_events
         WHERE threadId = ?
         ORDER BY id ASC
         LIMIT ?`
      )
      .all(threadId, limit) as ThreadEventRow[];
  }

  cleanupThreadEventsOlderThan(cutoffMs: number) {
    this.db.prepare("DELETE FROM thread_events WHERE createdAt < ?").run(cutoffMs);
  }
}
