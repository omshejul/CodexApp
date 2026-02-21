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

      CREATE INDEX IF NOT EXISTS idx_pair_expires ON pair_sessions (expiresAt);
      CREATE INDEX IF NOT EXISTS idx_refresh_expires ON refresh_tokens (expiresAt);
      CREATE INDEX IF NOT EXISTS idx_refresh_revoked ON refresh_tokens (revokedAt);
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

  cleanupRefreshTokens(now: number) {
    this.db.prepare("DELETE FROM refresh_tokens WHERE expiresAt < ? OR revokedAt IS NOT NULL").run(now);
  }

  listActiveDevices(now: number): Array<Pick<RefreshTokenRow, "id" | "deviceId" | "deviceName" | "createdAt" | "expiresAt">> {
    return this.db
      .prepare(
        `SELECT id, deviceId, deviceName, createdAt, expiresAt
         FROM refresh_tokens
         WHERE revokedAt IS NULL AND expiresAt > ?
         ORDER BY createdAt DESC`
      )
      .all(now) as Array<Pick<RefreshTokenRow, "id" | "deviceId" | "deviceName" | "createdAt" | "expiresAt">>;
  }
}
