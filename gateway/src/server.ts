import path from "node:path";
import fs from "node:fs";
import type { IncomingMessage } from "node:http";
import { ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import dotenv from "dotenv";
import Fastify, { FastifyReply, FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import jwt from "jsonwebtoken";
import QRCode from "qrcode";
import WebSocket from "ws";
import {
  AuthLogoutRequestSchema,
  AuthRefreshRequestSchema,
  AuthRefreshResponseSchema,
  GatewayOptionsResponseSchema,
  HealthResponseSchema,
  DirectoryBrowseResponseSchema,
  PairClaimRequestSchema,
  PairClaimResponseSchema,
  PairCreateResponseSchema,
  ThreadCreateRequestSchema,
  ThreadMessageRequestSchema,
  ThreadMessageResponseSchema,
  ThreadNameSetRequestSchema,
  ThreadNameSetResponseSchema,
  ThreadCreateResponseSchema,
  ThreadEventsResponseSchema,
  ThreadResponseSchema,
  ThreadResumeResponseSchema,
  ThreadsResponseSchema,
  WorkspacesResponseSchema,
} from "@codex-phone/shared";
import { CodexRpcClient } from "./codex-rpc";
import { GatewayDatabase, PairSessionRow, RefreshTokenRow } from "./db";
import { createRuntimeLogWriter } from "./runtime-logs";
import { generatePairCode, generateRefreshSecret, hashValue, safeEqualHex } from "./security";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_CODEX_URL = "ws://127.0.0.1:4500";
const PAIR_TTL_MS = 10 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ACCESS_TTL_SECONDS = 15 * 60;
const GATEWAY_VERSION = process.env.GATEWAY_VERSION ?? "0.1.0";
const GATEWAY_NAME = "codex-phone-gateway";

const port = Number(process.env.PORT ?? DEFAULT_PORT);
const host = process.env.HOST ?? DEFAULT_HOST;
const codexWsUrl = process.env.CODEX_WS_URL ?? DEFAULT_CODEX_URL;
const dbPath = process.env.DB_PATH ?? path.resolve(__dirname, "../data/gateway.sqlite");
const autoStartCodexAppServer = (process.env.AUTO_START_CODEX_APP_SERVER ?? "1") !== "0";
const codexAppServerBin = process.env.CODEX_APP_SERVER_BIN ?? "codex";
const codexAppServerListenUrl = process.env.CODEX_APP_SERVER_LISTEN ?? codexWsUrl;

const db = new GatewayDatabase(dbPath);
const jwtSecret = process.env.JWT_SECRET ?? db.getOrCreateJwtSecret();
const tokenHashSecret = process.env.TOKEN_HASH_SECRET ?? jwtSecret;
const publicBaseUrlOverride = process.env.PUBLIC_BASE_URL;
const eventsLogPath = process.env.EVENTS_LOG_PATH ?? path.resolve(__dirname, "../logs/events.log");
const errorsLogPath = process.env.ERRORS_LOG_PATH ?? path.resolve(__dirname, "../logs/errors.log");
const runtimeLogs = createRuntimeLogWriter(eventsLogPath, errorsLogPath);
const logLevel = process.env.LOG_LEVEL ?? "info";
const prettyLogsEnabled = (process.env.LOG_PRETTY ?? "1") !== "0";

const codex = new CodexRpcClient(codexWsUrl, GATEWAY_NAME, GATEWAY_VERSION);
let managedCodexProcess: ChildProcess | null = null;
const threadDiffHashes = new Map<string, string>();

let cachedDetectedBaseUrl: string | null = null;

interface AccessTokenPayload {
  typ: "access";
  sub: string;
  deviceName?: string;
}

function sanitizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function isLocalHost(value: string): boolean {
  const hostname = value.split(":")[0].toLowerCase();
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".local") ||
    hostname === "[::1]"
  );
}

function isLoopbackIp(ip: string | undefined): boolean {
  if (!ip) {
    return false;
  }
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function parseWsEndpoint(rawUrl: string): { host: string; port: number } | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      return null;
    }
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === "wss:" ? 443 : 80;
    if (!parsed.hostname || Number.isNaN(port) || port <= 0) {
      return null;
    }
    return { host: parsed.hostname, port };
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function isCodexWsReachable(url: string, timeoutMs = 1200): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, {
      perMessageDeflate: false,
    });

    let settled = false;
    const finish = (value: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // ignore close errors
      }
      resolve(value);
    };

    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("open", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function attachManagedProcessLogs(proc: ChildProcess) {
  const emit = (level: "info" | "warn", chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (!text) {
      return;
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      app.log[level]({ source: "codex-app-server" }, line);
    }
  };

  proc.stdout?.on("data", (chunk: Buffer) => emit("info", chunk));
  proc.stderr?.on("data", (chunk: Buffer) => emit("warn", chunk));
}

async function waitForCodexEndpoint(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isCodexWsReachable(url)) {
      return true;
    }
    await sleep(250);
  }
  return false;
}

async function ensureCodexAppServerRunning() {
  const endpoint = parseWsEndpoint(codexWsUrl);
  if (!endpoint) {
    app.log.warn({ codexWsUrl }, "Skipping auto-start: CODEX_WS_URL is not a ws:// or wss:// URL");
    return;
  }

  if (await isCodexWsReachable(codexWsUrl)) {
    app.log.info("Codex app-server already reachable");
    return;
  }

  if (!autoStartCodexAppServer) {
    app.log.warn("Codex app-server is not reachable and auto-start is disabled");
    return;
  }

  if (managedCodexProcess && managedCodexProcess.exitCode === null) {
    const reachable = await waitForCodexEndpoint(codexWsUrl, 10_000);
    if (reachable) {
      return;
    }
    throw new Error("Timed out waiting for already-started codex app-server process");
  }

  app.log.info(`Starting codex app-server: ${codexAppServerBin} app-server --listen ${codexAppServerListenUrl}`);
  const child = spawn(codexAppServerBin, ["app-server", "--listen", codexAppServerListenUrl], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  managedCodexProcess = child;
  attachManagedProcessLogs(child);
  const startupState: { spawnError?: Error } = {};

  child.once("error", (error) => {
    startupState.spawnError = error;
  });

  child.once("exit", (code, signal) => {
    if (managedCodexProcess?.pid === child.pid) {
      managedCodexProcess = null;
    }
    app.log.warn({ code, signal }, "Managed codex app-server exited");
  });

  const deadline = Date.now() + 15_000;
  let reachable = false;
  while (Date.now() < deadline) {
    if (startupState.spawnError) {
      throw new Error(`Failed to start codex app-server: ${startupState.spawnError.message}`);
    }
    if (child.exitCode !== null) {
      throw new Error(`codex app-server exited before becoming ready (code=${child.exitCode})`);
    }
    if (await isCodexWsReachable(codexWsUrl)) {
      reachable = true;
      break;
    }
    await sleep(250);
  }
  if (!reachable) {
    throw new Error("Timed out waiting for codex app-server to start listening");
  }

  app.log.info("Codex app-server started and reachable");
}

async function stopManagedCodexAppServer() {
  const proc = managedCodexProcess;
  if (!proc || proc.exitCode !== null) {
    managedCodexProcess = null;
    return;
  }

  await new Promise<void>((resolve) => {
    const killTimer = setTimeout(() => {
      if (proc.exitCode === null) {
        proc.kill("SIGKILL");
      }
    }, 2_000);

    proc.once("exit", () => {
      clearTimeout(killTimer);
      resolve();
    });

    proc.kill("SIGTERM");
  });

  managedCodexProcess = null;
}

function detectTailscaleBaseUrl(): string | null {
  if (cachedDetectedBaseUrl) {
    return cachedDetectedBaseUrl;
  }

  try {
    const raw = execFileSync("tailscale", ["status", "--json"], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    const parsed = JSON.parse(raw) as { Self?: { DNSName?: string } };
    const dns = parsed?.Self?.DNSName?.replace(/\.$/, "");
    if (dns) {
      cachedDetectedBaseUrl = `https://${dns}`;
      return cachedDetectedBaseUrl;
    }
  } catch {
    // fallthrough
  }

  try {
    const rawIp = execFileSync("tailscale", ["ip", "-4"], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    })
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (rawIp) {
      cachedDetectedBaseUrl = `https://${rawIp}`;
      return cachedDetectedBaseUrl;
    }
  } catch {
    return null;
  }

  return null;
}

function resolvePublicBaseUrl(request: FastifyRequest): string {
  if (publicBaseUrlOverride) {
    return sanitizeBaseUrl(publicBaseUrlOverride);
  }

  const forwardedHost = request.headers["x-forwarded-host"];
  const headerHost = typeof forwardedHost === "string" ? forwardedHost : request.headers.host;
  const proto = typeof request.headers["x-forwarded-proto"] === "string" ? request.headers["x-forwarded-proto"] : "http";

  if (headerHost && !isLocalHost(headerHost)) {
    return sanitizeBaseUrl(`${proto}://${headerHost}`);
  }

  const tailscaleBase = detectTailscaleBaseUrl();
  if (tailscaleBase) {
    return tailscaleBase;
  }

  return `http://127.0.0.1:${port}`;
}

function issueAccessToken(deviceId: string, deviceName: string): string {
  return jwt.sign(
    {
      typ: "access",
      sub: deviceId,
      deviceName,
    } satisfies AccessTokenPayload,
    jwtSecret,
    {
      algorithm: "HS256",
      expiresIn: ACCESS_TTL_SECONDS,
    }
  );
}

function buildDefaultDangerFullAccessSandboxPolicy() {
  return {
    type: "dangerFullAccess" as const,
  };
}

function parseRefreshToken(raw: string): { id: string; secret: string } | null {
  const parts = raw.split(".");
  if (parts.length !== 2) {
    return null;
  }
  const [id, secret] = parts;
  if (!id || !secret) {
    return null;
  }
  return { id, secret };
}

function createRefreshToken(deviceId: string, deviceName: string): { token: string; row: RefreshTokenRow } {
  const id = randomUUID();
  const secret = generateRefreshSecret();
  const now = Date.now();
  const expiresAt = now + REFRESH_TTL_MS;
  const tokenHash = hashValue(secret, tokenHashSecret);

  const row: RefreshTokenRow = {
    id,
    tokenHash,
    createdAt: now,
    expiresAt,
    revokedAt: null,
    deviceId,
    deviceName,
  };

  return {
    token: `${id}.${secret}`,
    row,
  };
}

function verifyRefreshToken(rawToken: string): RefreshTokenRow | null {
  const parsed = parseRefreshToken(rawToken);
  if (!parsed) {
    return null;
  }

  const row = db.getRefreshToken(parsed.id);
  if (!row) {
    return null;
  }

  if (row.revokedAt !== null || row.expiresAt <= Date.now()) {
    return null;
  }

  const candidateHash = hashValue(parsed.secret, tokenHashSecret);
  return safeEqualHex(candidateHash, row.tokenHash) ? row : null;
}

function ensureLocalRequest(request: FastifyRequest, reply: FastifyReply): boolean {
  if (isLoopbackIp(request.ip)) {
    return true;
  }
  reply.code(403).send({ error: "This endpoint is local-only." });
  return false;
}

async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  const header = request.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    runtimeLogs.event("auth.missing_bearer", { method: request.method, url: request.url, ip: request.ip });
    reply.code(401).send({ error: "Missing bearer token" });
    return;
  }

  const token = header.slice("Bearer ".length);
  try {
    const payload = jwt.verify(token, jwtSecret, { algorithms: ["HS256"] }) as jwt.JwtPayload;
    if (payload.typ !== "access" || typeof payload.sub !== "string") {
      runtimeLogs.event("auth.invalid_access_token", { method: request.method, url: request.url, ip: request.ip });
      reply.code(401).send({ error: "Invalid access token" });
      return;
    }

    request.auth = {
      deviceId: payload.sub,
      deviceName: typeof payload.deviceName === "string" ? payload.deviceName : undefined,
    };
  } catch {
    runtimeLogs.event("auth.invalid_access_token", { method: request.method, url: request.url, ip: request.ip });
    reply.code(401).send({ error: "Invalid access token" });
  }
}

function verifyAccessToken(token: string): { deviceId: string; deviceName?: string } | null {
  try {
    const payload = jwt.verify(token, jwtSecret, { algorithms: ["HS256"] }) as jwt.JwtPayload;
    if (payload.typ !== "access" || typeof payload.sub !== "string") {
      return null;
    }
    return {
      deviceId: payload.sub,
      deviceName: typeof payload.deviceName === "string" ? payload.deviceName : undefined,
    };
  } catch {
    return null;
  }
}

function getWsBearerToken(request: IncomingMessage, parsedUrl: URL): string | null {
  const authHeader = request.headers.authorization;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length);
  }

  const queryToken = parsedUrl.searchParams.get("access_token") ?? parsedUrl.searchParams.get("token");
  if (queryToken && queryToken.trim().length > 0) {
    return queryToken;
  }

  return null;
}

function parseThreadNameUpdate(
  method: string,
  params: unknown
): {
  threadId: string;
  name: string;
} | null {
  const pickNonEmptyString = (...values: unknown[]): string | null => {
    for (const value of values) {
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
    return null;
  };

  if (!params || typeof params !== "object") {
    return null;
  }

  if (method !== "thread/name/updated" && method !== "codex/event/thread_name_updated") {
    return null;
  }

  const record = params as Record<string, unknown>;
  const nestedMsg = record.msg && typeof record.msg === "object" ? (record.msg as Record<string, unknown>) : null;
  const threadId = pickNonEmptyString(record.threadId, record.thread_id, nestedMsg?.threadId, nestedMsg?.thread_id);
  const name = pickNonEmptyString(record.threadName, record.thread_name, record.name, nestedMsg?.threadName, nestedMsg?.thread_name);
  if (!threadId || !name) {
    return null;
  }

  return {
    threadId,
    name,
  };
}

function extractThreadIdFromParams(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = extractThreadIdFromParams(entry);
      if (found) {
        return found;
      }
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  const candidates = [record.threadId, record.thread_id, record.threadID, record.conversationId];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  for (const nested of Object.values(record)) {
    const found = extractThreadIdFromParams(nested);
    if (found) {
      return found;
    }
  }
  return null;
}

function runGitDiffAllowExitOne(args: string[]): string {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 8,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (error) {
    if (error && typeof error === "object" && "stdout" in error) {
      const stdout = (error as { stdout?: unknown }).stdout;
      if (typeof stdout === "string") {
        return stdout;
      }
      if (Buffer.isBuffer(stdout)) {
        return stdout.toString("utf8");
      }
    }
    return "";
  }
}

function buildThreadDiffSnapshotEvent(threadId: string): { method: string; params: { threadId: string; cwd: string; diff: string } } | null {
  const threadCwd = db.getThreadCwd(threadId);
  const cwd = threadCwd?.cwd?.trim();
  if (!cwd) {
    return null;
  }

  try {
    const trackedDiff = execFileSync("git", ["-C", cwd, "diff", "--no-color", "--no-ext-diff", "--", "."], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 8,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const untrackedRaw = execFileSync("git", ["-C", cwd, "ls-files", "--others", "--exclude-standard", "--", "."], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 2,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const untrackedFiles = untrackedRaw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const untrackedDiffs = untrackedFiles
      .map((relativePath) =>
        runGitDiffAllowExitOne(["-C", cwd, "diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", relativePath])
      )
      .filter((chunk) => chunk.trim().length > 0);

    const diff = [trackedDiff, ...untrackedDiffs].filter((chunk) => chunk.trim().length > 0).join("\n").trim();
    if (!diff.includes("diff --git")) {
      return null;
    }

    const hash = createHash("sha1").update(diff).digest("hex");
    const previous = threadDiffHashes.get(threadId);
    if (previous === hash) {
      return null;
    }
    threadDiffHashes.set(threadId, hash);
    return {
      method: "gateway/diff/snapshot",
      params: {
        threadId,
        cwd,
        diff,
      },
    };
  } catch {
    return null;
  }
}

function normalizeThreads(result: unknown): Array<{ id: string; name?: string; title?: string; updatedAt?: string; cwd?: string }> {
  const pickNonEmptyString = (...values: unknown[]): string | undefined => {
    for (const value of values) {
      if (typeof value === "string" && value.trim().length > 0) {
        return value;
      }
    }
    return undefined;
  };
  const summarizePreview = (value: string): string => {
    const singleLine = value.replace(/\s+/g, " ").trim();
    if (singleLine.length <= 140) {
      return singleLine;
    }
    return `${singleLine.slice(0, 137)}...`;
  };

  const asObject = result && typeof result === "object" ? (result as Record<string, unknown>) : null;
  const threadArray = Array.isArray(result)
    ? result
    : Array.isArray(asObject?.threads)
    ? (asObject.threads as unknown[])
    : Array.isArray(asObject?.data)
    ? (asObject.data as unknown[])
    : Array.isArray(asObject?.items)
    ? (asObject.items as unknown[])
    : [];

  return threadArray.reduce<Array<{ id: string; name?: string; title?: string; updatedAt?: string; cwd?: string }>>((acc, item) => {
    if (!item || typeof item !== "object") {
      return acc;
    }

    const row = item as Record<string, unknown>;
    const nested = row.thread && typeof row.thread === "object" ? (row.thread as Record<string, unknown>) : null;
    const id = row.id ?? row.threadId;
    if (typeof id !== "string" || id.length === 0) {
      return acc;
    }

    const name = pickNonEmptyString(row.name, row.threadName, nested?.name, nested?.threadName, row.title, nested?.title);
    const previewValue = pickNonEmptyString(row.preview, nested?.preview);
    const title = pickNonEmptyString(row.title, nested?.title) ?? (previewValue ? summarizePreview(previewValue) : undefined);
    const cwd = pickNonEmptyString(row.cwd, row.workingDirectory, row.workdir, nested?.cwd, nested?.workingDirectory, nested?.workdir);
    const updatedRaw = row.updatedAt ?? row.updated_at ?? row.createdAt ?? row.created_at ?? nested?.updatedAt ?? nested?.updated_at;
    const updatedAt =
      typeof updatedRaw === "string"
        ? updatedRaw
        : typeof updatedRaw === "number" && Number.isFinite(updatedRaw)
        ? new Date(updatedRaw * 1000).toISOString()
        : undefined;
    acc.push({ id, name, title, updatedAt, cwd });
    return acc;
  }, []);
}

function listChildDirectories(root: string, limit = 50): string[] {
  try {
    const entries = execFileSync("find", [root, "-mindepth", "1", "-maxdepth", "1", "-type", "d"], {
      encoding: "utf8",
      maxBuffer: 1024 * 512,
    })
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .slice(0, limit);
    return entries;
  } catch {
    return [];
  }
}

function buildWorkspaceSuggestions(): { defaultCwd: string; workspaces: string[] } {
  const defaultCwd = process.cwd();
  const suggestions = new Set<string>([defaultCwd]);
  const parent = path.resolve(defaultCwd, "..");
  if (parent !== defaultCwd) {
    suggestions.add(parent);
  }
  const envRoots = (process.env.WORKSPACE_ROOTS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const roots = envRoots.length > 0 ? envRoots : [parent];
  for (const root of roots) {
    suggestions.add(root);
    for (const child of listChildDirectories(root)) {
      suggestions.add(child);
    }
  }
  return {
    defaultCwd,
    workspaces: Array.from(suggestions),
  };
}

function normalizeBrowsePath(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return process.cwd();
  }
  const resolved = path.resolve(raw.trim());
  if (!fs.existsSync(resolved)) {
    return process.cwd();
  }
  try {
    const stats = fs.statSync(resolved);
    return stats.isDirectory() ? resolved : path.dirname(resolved);
  } catch {
    return process.cwd();
  }
}

function browseDirectories(rawPath: unknown): { currentPath: string; parentPath: string | null; folders: Array<{ name: string; path: string }> } {
  const currentPath = normalizeBrowsePath(rawPath);
  let entries: Array<{ name: string; path: string }> = [];
  try {
    entries = fs
      .readdirSync(currentPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        name: entry.name,
        path: path.join(currentPath, entry.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  } catch {
    entries = [];
  }
  const parentPath = path.dirname(currentPath);

  return {
    currentPath,
    parentPath: parentPath === currentPath ? null : parentPath,
    folders: entries,
  };
}

function normalizeThread(result: unknown, fallbackId: string): { id: string; name?: string; title?: string; turns: unknown[] } {
  if (result && typeof result === "object") {
    const topLevel = result as Record<string, unknown>;
    const nested = (topLevel.thread ?? topLevel) as Record<string, unknown>;
    const idCandidate = nested.id ?? nested.threadId;
    const turnsCandidate = nested.turns;

    const id = typeof idCandidate === "string" && idCandidate.length > 0 ? idCandidate : fallbackId;
    const name = typeof nested.name === "string" ? nested.name : undefined;
    const title = typeof nested.title === "string" ? nested.title : undefined;
    const turns = Array.isArray(turnsCandidate) ? turnsCandidate : [];

    return { id, name, title, turns };
  }

  return { id: fallbackId, turns: [] };
}

function isUnmaterializedThreadError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("no rollout found for thread id") ||
    message.includes("not materialized yet") ||
    message.includes("includeturns is unavailable before first user message")
  );
}

function normalizeGatewayOptions(result: unknown) {
  const asObject = result && typeof result === "object" ? (result as Record<string, unknown>) : null;
  const modelArray = Array.isArray(asObject?.data)
    ? (asObject?.data as unknown[])
    : Array.isArray(asObject?.models)
    ? (asObject?.models as unknown[])
    : [];

  const models = modelArray.reduce<
    Array<{
      id: string;
      model: string;
      label: string;
      isDefault: boolean;
      supportedReasoningEfforts: Array<"none" | "minimal" | "low" | "medium" | "high" | "xhigh">;
      defaultReasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
    }>
  >((acc, item) => {
    if (!item || typeof item !== "object") {
      return acc;
    }

    const row = item as Record<string, unknown>;
    const model = typeof row.model === "string" ? row.model : null;
    const id = typeof row.id === "string" ? row.id : model;
    if (!model || !id) {
      return acc;
    }

    const displayName = typeof row.displayName === "string" && row.displayName.trim().length > 0 ? row.displayName : model;
    const isDefault = row.isDefault === true;

    const reasoningFromModel = Array.isArray(row.supportedReasoningEfforts) ? row.supportedReasoningEfforts : [];
    const supportedReasoningEfforts = reasoningFromModel
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return null;
        }
        const effort = (entry as Record<string, unknown>).reasoningEffort;
        if (
          effort === "none" ||
          effort === "minimal" ||
          effort === "low" ||
          effort === "medium" ||
          effort === "high" ||
          effort === "xhigh"
        ) {
          return effort;
        }
        return null;
      })
      .filter((value): value is "none" | "minimal" | "low" | "medium" | "high" | "xhigh" => value !== null);

    const defaultReasoningEffort =
      row.defaultReasoningEffort === "none" ||
      row.defaultReasoningEffort === "minimal" ||
      row.defaultReasoningEffort === "low" ||
      row.defaultReasoningEffort === "medium" ||
      row.defaultReasoningEffort === "high" ||
      row.defaultReasoningEffort === "xhigh"
        ? row.defaultReasoningEffort
        : undefined;

    acc.push({
      id,
      model,
      label: displayName,
      isDefault,
      supportedReasoningEfforts,
      defaultReasoningEffort,
    });
    return acc;
  }, []);

  const defaultModel = models.find((model) => model.isDefault)?.model;
  const defaultReasoningEffort = models.find((model) => model.isDefault)?.defaultReasoningEffort;

  return {
    models,
    defaultModel,
    defaultReasoningEffort,
  };
}

const app = Fastify({
  logger: prettyLogsEnabled
    ? {
        level: logLevel,
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:standard",
            ignore: "pid,hostname",
          },
        },
      }
    : {
        level: logLevel,
      },
});

async function bootstrap() {
  runtimeLogs.event("gateway.bootstrap.start", { host, port, codexWsUrl, eventsLogPath, errorsLogPath });

  if (!isLocalHost(host)) {
    throw new Error(`Refusing to start gateway on non-local HOST='${host}'. Use 127.0.0.1 or localhost.`);
  }

  codex.setServerRequestHandler(async ({ method }) => {
    app.log.warn(
      { method },
      "Codex app-server requested interactive approval/input; denying because gateway is non-interactive"
    );
    throw new Error("Interactive approval requests are not supported by codex-phone gateway");
  });

  codex.onNotification((method, params) => {
    const threadId = extractThreadIdFromParams(params);
    if (threadId) {
      try {
        db.insertThreadEvent(threadId, method, JSON.stringify(params ?? null), Date.now());
        if (method === "turn/completed") {
          const snapshot = buildThreadDiffSnapshotEvent(threadId);
          if (snapshot) {
            db.insertThreadEvent(threadId, snapshot.method, JSON.stringify(snapshot.params), Date.now());
            runtimeLogs.event("thread.events.synthetic_diff", { threadId, source: "notification" });
          }
        }
      } catch (error) {
        runtimeLogs.error("thread.events.persist_failed", error, { threadId, method });
      }
    }

    const update = parseThreadNameUpdate(method, params);
    if (!update) {
      return;
    }
    db.upsertThreadName({
      threadId: update.threadId,
      name: update.name,
      updatedAt: Date.now(),
    });
    runtimeLogs.event("thread.name.synced", { method, threadId: update.threadId });
  });

  await ensureCodexAppServerRunning();

  await app.register(cors, {
    origin: true,
    credentials: false,
  });

  await app.register(rateLimit, {
    global: false,
    max: 20,
    timeWindow: "1 minute",
  });

  app.addHook("onRequest", async (request) => {
    runtimeLogs.event("http.request", {
      id: request.id,
      method: request.method,
      url: request.url,
      ip: request.ip,
    });
  });

  app.addHook("onResponse", async (request, reply) => {
    runtimeLogs.event("http.response", {
      id: request.id,
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      ip: request.ip,
    });
  });

  app.get("/health", async (_request, reply) => {
    let codexReachable = true;
    let codexError: string | undefined;

    try {
      await codex.call("thread/list", { limit: 1 });
    } catch (error) {
      codexReachable = false;
      codexError = error instanceof Error ? error.message : "unknown error";
    }

    const payload = HealthResponseSchema.parse({
      ok: true,
      codexReachable,
      gatewayVersion: GATEWAY_VERSION,
      codexError,
    });
    return reply.send(payload);
  });

  app.get("/pair", async (request, reply) => {
    if (!ensureLocalRequest(request, reply)) {
      return;
    }

    reply.type("text/html; charset=utf-8").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Codex Phone Pairing</title>
  <style>
    body { font-family: ui-sans-serif, -apple-system, sans-serif; padding: 24px; color: #111827; background: #f9fafb; }
    .card { max-width: 520px; margin: 0 auto; background: white; border-radius: 16px; padding: 20px; box-shadow: 0 10px 30px rgba(0,0,0,.08); }
    button { background: #111827; color: white; border: 0; border-radius: 10px; padding: 10px 14px; cursor: pointer; font-weight: 600; }
    img { width: 280px; height: 280px; display: block; margin: 12px auto; border: 8px solid #fff; box-shadow: 0 2px 10px rgba(0,0,0,.12); }
    code { display: block; padding: 10px; background: #f3f4f6; border-radius: 8px; overflow-wrap: anywhere; }
    .muted { color: #6b7280; font-size: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Codex Phone Pairing</h1>
    <p class="muted">Open the Codex Phone app and scan this QR code.</p>
    <button id="regen">Generate new pairing QR</button>
    <img id="qr" alt="pairing QR" />
    <p><strong>Code:</strong> <span id="code"></span></p>
    <p><strong>Expires:</strong> <span id="expires"></span></p>
    <p class="muted">Pairing URL</p>
    <code id="url"></code>
  </div>
  <script>
    async function loadPairing() {
      const response = await fetch('/pair/create', { method: 'POST' });
      const data = await response.json();
      document.getElementById('code').textContent = data.code;
      document.getElementById('expires').textContent = new Date(data.expiresAt).toLocaleString();
      document.getElementById('url').textContent = data.pairingUrl;
      document.getElementById('qr').src = '/pair/qr?value=' + encodeURIComponent(data.pairingUrl);
    }
    document.getElementById('regen').addEventListener('click', loadPairing);
    loadPairing();
  </script>
</body>
</html>`);
  });

  app.get("/pair/qr", async (request, reply) => {
    const query = request.query as { value?: string };
    if (!query.value) {
      return reply.code(400).send({ error: "Missing value query param" });
    }

    const png = await QRCode.toBuffer(query.value, {
      width: 320,
      margin: 1,
      errorCorrectionLevel: "M",
    });

    reply.type("image/png").send(png);
  });

  app.get("/pair/claim", async (_request, reply) => {
    reply.type("text/plain; charset=utf-8").send("Use the Codex Phone app to scan this URL and complete pairing.");
  });

  app.post("/pair/create", async (request, reply) => {
    db.cleanupPairSessions(Date.now());

    const pairId = randomUUID();
    const code = generatePairCode(18);
    const now = Date.now();
    const expiresAtMillis = now + PAIR_TTL_MS;
    const row: PairSessionRow = {
      pairId,
      codeHash: hashValue(code, tokenHashSecret),
      expiresAt: expiresAtMillis,
      usedAt: null,
    };

    db.insertPairSession(row);

    const baseUrl = resolvePublicBaseUrl(request);
    const pairingUrl = `${baseUrl}/pair/claim?pairId=${encodeURIComponent(pairId)}&code=${encodeURIComponent(code)}`;
    const payload = PairCreateResponseSchema.parse({
      pairId,
      code,
      expiresAt: new Date(expiresAtMillis).toISOString(),
      pairingUrl,
    });

    return reply.send(payload);
  });

  app.post(
    "/pair/claim",
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "1 minute",
        },
      },
    },
    async (request, reply) => {
      const parsedBody = PairClaimRequestSchema.safeParse(request.body);
      if (!parsedBody.success) {
        return reply.code(400).send({ error: parsedBody.error.flatten() });
      }

      const { pairId, code, deviceId, deviceName } = parsedBody.data;
      const session = db.getPairSession(pairId);

      if (!session) {
        return reply.code(400).send({ error: "Invalid pairing code" });
      }

      if (session.usedAt !== null) {
        return reply.code(409).send({ error: "Pairing session already used" });
      }

      if (session.expiresAt <= Date.now()) {
        return reply.code(410).send({ error: "Pairing session expired" });
      }

      const candidateHash = hashValue(code, tokenHashSecret);
      if (!safeEqualHex(candidateHash, session.codeHash)) {
        return reply.code(401).send({ error: "Invalid pairing code" });
      }

      db.markPairSessionUsed(pairId, Date.now());

      const accessToken = issueAccessToken(deviceId, deviceName);
      const refresh = createRefreshToken(deviceId, deviceName);
      db.insertRefreshToken(refresh.row);

      const payload = PairClaimResponseSchema.parse({
        accessToken,
        refreshToken: refresh.token,
        serverInfo: {
          name: GATEWAY_NAME,
          version: GATEWAY_VERSION,
        },
      });

      return reply.send(payload);
    }
  );

  app.post("/auth/refresh", async (request, reply) => {
    const parsedBody = AuthRefreshRequestSchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ error: parsedBody.error.flatten() });
    }

    const tokenRecord = verifyRefreshToken(parsedBody.data.refreshToken);
    if (!tokenRecord) {
      return reply.code(401).send({ error: "Invalid refresh token" });
    }

    const payload = AuthRefreshResponseSchema.parse({
      accessToken: issueAccessToken(tokenRecord.deviceId, tokenRecord.deviceName),
    });

    return reply.send(payload);
  });

  app.post("/auth/logout", async (request, reply) => {
    const parsedBody = AuthLogoutRequestSchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ error: parsedBody.error.flatten() });
    }

    const parsedToken = parseRefreshToken(parsedBody.data.refreshToken);
    if (parsedToken) {
      db.revokeRefreshToken(parsedToken.id, Date.now());
    }

    return reply.send({ ok: true });
  });

  app.get("/devices", async (request, reply) => {
    if (!ensureLocalRequest(request, reply)) {
      return;
    }
    return reply.send({ devices: db.listActiveDevices(Date.now()) });
  });

  app.post("/devices/:id/revoke", async (request, reply) => {
    if (!ensureLocalRequest(request, reply)) {
      return;
    }
    const params = request.params as { id: string };
    db.revokeRefreshToken(params.id, Date.now());
    return reply.send({ ok: true });
  });

  app.get("/threads", { preHandler: [requireAuth] }, async (_request, reply) => {
    const result = await codex.call("thread/list", {});
    const normalized = normalizeThreads(result);
    const persistedNames = db.getThreadNames(normalized.map((item) => item.id));
    const persistedCwds = db.getThreadCwds(normalized.map((item) => item.id));
    const now = Date.now();
    for (const item of normalized) {
      if (item.cwd && item.cwd.trim().length > 0) {
        db.upsertThreadCwd({
          threadId: item.id,
          cwd: item.cwd.trim(),
          updatedAt: now,
        });
      }
    }
    const payload = ThreadsResponseSchema.parse({
      threads: normalized.map((item) => ({
        ...item,
        name: persistedNames.get(item.id)?.name ?? item.name,
        cwd: persistedCwds.get(item.id)?.cwd ?? item.cwd,
      })),
    });
    return reply.send(payload);
  });

  app.get("/workspaces", { preHandler: [requireAuth] }, async (_request, reply) => {
    const payload = WorkspacesResponseSchema.parse(buildWorkspaceSuggestions());
    return reply.send(payload);
  });

  app.get("/directories", { preHandler: [requireAuth] }, async (request, reply) => {
    const query = request.query as { path?: string };
    const payload = DirectoryBrowseResponseSchema.parse(browseDirectories(query.path));
    return reply.send(payload);
  });

  app.post("/threads", { preHandler: [requireAuth] }, async (request, reply) => {
    const parsedBody = ThreadCreateRequestSchema.safeParse(request.body ?? {});
    if (!parsedBody.success) {
      return reply.code(400).send({ error: parsedBody.error.flatten() });
    }

    const trimmedCwd = parsedBody.data.cwd?.trim();
    const result = await codex.call("thread/start", {
      approvalPolicy: "never",
      sandboxPolicy: buildDefaultDangerFullAccessSandboxPolicy(),
      ...(trimmedCwd ? { cwd: trimmedCwd } : {}),
    });

    const threadId = (() => {
      if (!result || typeof result !== "object") {
        return null;
      }
      const topLevel = result as Record<string, unknown>;
      if (typeof topLevel.threadId === "string" && topLevel.threadId.length > 0) {
        return topLevel.threadId;
      }
      if (typeof topLevel.id === "string" && topLevel.id.length > 0) {
        return topLevel.id;
      }
      const thread = topLevel.thread;
      if (thread && typeof thread === "object" && typeof (thread as Record<string, unknown>).id === "string") {
        return (thread as Record<string, string>).id;
      }
      return null;
    })();

    if (!threadId) {
      throw new Error("thread/start returned no thread id");
    }

    if (trimmedCwd && trimmedCwd.length > 0) {
      db.upsertThreadCwd({
        threadId,
        cwd: trimmedCwd,
        updatedAt: Date.now(),
      });
    }

    const payload = ThreadCreateResponseSchema.parse({
      ok: true,
      threadId,
    });
    return reply.send(payload);
  });

  app.get("/threads/:id", { preHandler: [requireAuth] }, async (request, reply) => {
    const params = request.params as { id: string };
    let result: unknown;
    try {
      result = await codex.call("thread/read", {
        threadId: params.id,
        includeTurns: true,
      });
    } catch (error) {
      if (isUnmaterializedThreadError(error)) {
        const payload = ThreadResponseSchema.parse({
          id: params.id,
          turns: [],
        });
        return reply.send(payload);
      }
      throw error;
    }

    const normalized = normalizeThread(result, params.id);
    const persisted = db.getThreadName(normalized.id);
    const payload = ThreadResponseSchema.parse({
      ...normalized,
      name: persisted?.name ?? normalized.name,
    });
    return reply.send(payload);
  });

  app.get("/threads/:id/events", { preHandler: [requireAuth] }, async (request, reply) => {
    const params = request.params as { id: string };
    const rows = db.listThreadEvents(params.id, 1000);
    const payload = ThreadEventsResponseSchema.parse({
      events: rows.map((row) => {
        let parsedParams: unknown = null;
        try {
          parsedParams = JSON.parse(row.paramsJson);
        } catch {
          parsedParams = null;
        }
        return {
          id: row.id,
          threadId: row.threadId,
          method: row.method,
          params: parsedParams,
          createdAt: new Date(row.createdAt).toISOString(),
        };
      }),
    });
    return reply.send(payload);
  });

  app.post("/threads/:id/name", { preHandler: [requireAuth] }, async (request, reply) => {
    const params = request.params as { id: string };
    const parsedBody = ThreadNameSetRequestSchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ error: parsedBody.error.flatten() });
    }

    const name = parsedBody.data.name.trim();
    try {
      await codex.call("thread/resume", {
        threadId: params.id,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      });
    } catch (error) {
      if (!isUnmaterializedThreadError(error)) {
        throw error;
      }
    }

    await codex.call("thread/name/set", {
      threadId: params.id,
      name,
    });

    db.upsertThreadName({
      threadId: params.id,
      name,
      updatedAt: Date.now(),
    });

    const payload = ThreadNameSetResponseSchema.parse({
      ok: true,
      threadId: params.id,
      name,
    });
    return reply.send(payload);
  });

  app.get("/options", { preHandler: [requireAuth] }, async (_request, reply) => {
    const result = await codex.call("model/list", {});
    const payload = GatewayOptionsResponseSchema.parse(normalizeGatewayOptions(result));
    return reply.send(payload);
  });

  app.post("/threads/:id/resume", { preHandler: [requireAuth] }, async (request, reply) => {
    const params = request.params as { id: string };
    try {
      await codex.call("thread/resume", {
        threadId: params.id,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      });
    } catch (error) {
      if (!isUnmaterializedThreadError(error)) {
        throw error;
      }
      runtimeLogs.event("thread.resume.unmaterialized", { threadId: params.id });
    }

    const payload = ThreadResumeResponseSchema.parse({ ok: true });
    return reply.send(payload);
  });

  app.post("/threads/:id/message", { preHandler: [requireAuth] }, async (request, reply) => {
    const params = request.params as { id: string };
    const parsedBody = ThreadMessageRequestSchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ error: parsedBody.error.flatten() });
    }

    const result = await codex.call("turn/start", {
      threadId: params.id,
      approvalPolicy: "never",
      sandboxPolicy: buildDefaultDangerFullAccessSandboxPolicy(),
      model: parsedBody.data.model ?? null,
      effort: parsedBody.data.reasoningEffort ?? null,
      input: [{ type: "text", text: parsedBody.data.text, text_elements: [] }],
    });

    const turnId = (() => {
      if (!result || typeof result !== "object") {
        return undefined;
      }

      const topLevel = result as Record<string, unknown>;
      if (typeof topLevel.turnId === "string" && topLevel.turnId.length > 0) {
        return topLevel.turnId;
      }

      const turn = topLevel.turn;
      if (turn && typeof turn === "object" && typeof (turn as Record<string, unknown>).id === "string") {
        return (turn as Record<string, string>).id;
      }

      return undefined;
    })();

    const payload = ThreadMessageResponseSchema.parse({
      ok: true,
      turnId,
    });

    return reply.send(payload);
  });

  app.get("/threads/:id/stream", { preHandler: [requireAuth] }, async (request, reply) => {
    const params = request.params as { id: string };
    runtimeLogs.event("stream.sse.open", { threadId: params.id, ip: request.ip });

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const sendEvent = (payload: { method: string; params: unknown }) => {
      runtimeLogs.event("stream.sse.event", { threadId: params.id, method: payload.method });
      reply.raw.write(`event: codex\n`);
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
      if (payload.method === "turn/completed") {
        const snapshot = buildThreadDiffSnapshotEvent(params.id);
        if (snapshot) {
          db.insertThreadEvent(params.id, snapshot.method, JSON.stringify(snapshot.params), Date.now());
          runtimeLogs.event("thread.events.synthetic_diff", { threadId: params.id });
          reply.raw.write(`event: codex\n`);
          reply.raw.write(`data: ${JSON.stringify(snapshot)}\n\n`);
        }
      }
    };

    sendEvent({
      method: "stream/ready",
      params: {
        threadId: params.id,
      },
    });

    const unsubscribe = codex.subscribeThread(params.id, sendEvent);
    const keepAlive = setInterval(() => {
      reply.raw.write(`: keepalive ${Date.now()}\n\n`);
    }, 15_000);

    request.raw.on("close", () => {
      runtimeLogs.event("stream.sse.close", { threadId: params.id, ip: request.ip });
      clearInterval(keepAlive);
      unsubscribe();
      reply.raw.end();
    });
  });

  app.setErrorHandler((error, _request, reply) => {
    requestLogSafeError(error);
    runtimeLogs.error("http.error", error);
    if (reply.sent) {
      return;
    }
    reply.code(500).send({ error: "Internal server error" });
  });

  const shutdown = async () => {
    try {
      try {
        await app.close();
      } finally {
        await stopManagedCodexAppServer();
      }
    } finally {
      db.close();
      process.exit(0);
    }
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await app.listen({
    host,
    port,
  });

  const streamSocketServer = new WebSocket.Server({
    noServer: true,
    perMessageDeflate: false,
  });

  app.server.on("upgrade", (request, socket, head) => {
    const hostHeader = request.headers.host ?? `127.0.0.1:${port}`;
    const parsedUrl = new URL(request.url ?? "/", `http://${hostHeader}`);
    const match = parsedUrl.pathname.match(/^\/threads\/([^/]+)\/ws$/);
    if (!match) {
      runtimeLogs.event("stream.ws.rejected_path", { url: parsedUrl.pathname, ip: request.socket.remoteAddress });
      socket.destroy();
      return;
    }

    const token = getWsBearerToken(request, parsedUrl);
    if (!token || !verifyAccessToken(token)) {
      runtimeLogs.event("stream.ws.auth_failed", { threadId: decodeURIComponent(match[1]), ip: request.socket.remoteAddress });
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    const threadId = decodeURIComponent(match[1]);
    streamSocketServer.handleUpgrade(request, socket, head, (ws) => {
      runtimeLogs.event("stream.ws.open", { threadId, ip: request.socket.remoteAddress });
      const sendPayload = (payload: { method: string; params: unknown }) => {
        if (ws.readyState !== WebSocket.OPEN) {
          return;
        }
        runtimeLogs.event("stream.ws.event", { threadId, method: payload.method });
        ws.send(JSON.stringify(payload));
        if (payload.method === "turn/completed") {
          const snapshot = buildThreadDiffSnapshotEvent(threadId);
          if (snapshot) {
            db.insertThreadEvent(threadId, snapshot.method, JSON.stringify(snapshot.params), Date.now());
            runtimeLogs.event("thread.events.synthetic_diff", { threadId });
            ws.send(JSON.stringify(snapshot));
          }
        }
      };

      sendPayload({
        method: "stream/ready",
        params: {
          threadId,
        },
      });

      const unsubscribe = codex.subscribeThread(threadId, sendPayload);
      const keepAlive = setInterval(() => {
        sendPayload({
          method: "stream/keepalive",
          params: {
            ts: Date.now(),
          },
        });
      }, 15_000);

      ws.on("close", () => {
        runtimeLogs.event("stream.ws.close", { threadId, ip: request.socket.remoteAddress });
        clearInterval(keepAlive);
        unsubscribe();
      });

      ws.on("error", (error) => {
        runtimeLogs.error("stream.ws.error", error, { threadId, ip: request.socket.remoteAddress });
        clearInterval(keepAlive);
        unsubscribe();
      });
    });
  });

  app.log.info(`Gateway listening on http://${host}:${port}`);
  app.log.info(`Codex app-server target: ${codexWsUrl}`);
  runtimeLogs.event("gateway.bootstrap.ready", { host, port, codexWsUrl });
}

function requestLogSafeError(error: unknown) {
  if (error instanceof Error) {
    app.log.error({ name: error.name, message: error.message, stack: error.stack }, "request failed");
    return;
  }
  app.log.error({ error }, "request failed");
}

bootstrap().catch(async (error) => {
  requestLogSafeError(error);
  runtimeLogs.error("gateway.bootstrap.failed", error);
  await stopManagedCodexAppServer();
  db.close();
  process.exit(1);
});
