import {
  AppPresenceUpsertResponseSchema,
  AuthRefreshResponseSchema,
  DirectoryBrowseResponseSchema,
  DirectoryCreateRequest,
  DirectoryCreateResponseSchema,
  GatewayOptionsResponseSchema,
  InteractiveRequestRespondResponseSchema,
  InteractiveRequestsResponseSchema,
  PairedDevicesResponseSchema,
  PushTokenUpsertResponseSchema,
  ThreadCreateRequest,
  PairClaimRequest,
  PairClaimResponseSchema,
  type ThreadGoal,
  ThreadGoalClearResponseSchema,
  ThreadGoalResponseSchema,
  type ThreadGoalSetRequest,
  ThreadMessageRequest,
  ThreadMessageResponseSchema,
  type QueuedThreadMessage as SharedQueuedThreadMessage,
  QueuedThreadMessagesResponseSchema,
  QueuedThreadMessageEnqueueResponseSchema,
  QueuedThreadMessageRemoveResponseSchema,
  QueuedThreadMessageSteerResponseSchema,
  ThreadInterruptRequest,
  ThreadInterruptResponseSchema,
  ThreadCreateResponseSchema,
  ThreadEventsResponseSchema,
  ThreadFilesResponseSchema,
  ThreadResponseSchema,
  ThreadResumeResponseSchema,
  ThreadsResponseSchema,
  WorkspacesResponseSchema,
} from "@codex-phone/shared";
import * as SecureStore from "expo-secure-store";

const LEGACY_SERVER_BASE_URL_KEY = "codex_phone_server_base_url";
const LEGACY_REFRESH_TOKEN_KEY = "codex_phone_refresh_token";
const GATEWAY_STORE_KEY = "codex_phone_gateways_v1";
const MAX_GATEWAY_NICKNAME_LENGTH = 40;
const GATEWAY_LAST_USED_PERSIST_INTERVAL_MS = 30_000;
const PAIRING_ROUTE_MISCONFIG_STATUSES = new Set([404, 405, 502, 503]);
const PAIRING_ROUTE_FALLBACK_BASE_PATHS = ["/codex-gateway", "/codexgateway"] as const;

export type GatewayId = string;

export interface GatewayRecord {
  id: GatewayId;
  serverBaseUrl: string;
  refreshToken: string;
  nickname: string;
  serverInfoName?: string;
  serverInfoVersion?: string;
  pairedAt: number;
  lastUsedAt: number;
}

export interface GatewayStoreV1 {
  version: 1;
  activeGatewayId: GatewayId | null;
  gateways: GatewayRecord[];
}

export interface GatewaySummary {
  id: GatewayId;
  nickname: string;
  serverBaseUrl: string;
  host: string;
  isActive: boolean;
  pairedAt: number;
  lastUsedAt: number;
}

export type QueuedThreadMessage = SharedQueuedThreadMessage;
export type { ThreadGoal, ThreadGoalSetRequest };

let gatewayStoreCache: GatewayStoreV1 | null = null;
let gatewayStoreLoaded = false;
const accessTokenByGatewayId = new Map<GatewayId, string | null>();
const refreshPromiseByGatewayId = new Map<GatewayId, Promise<string>>();

export class ReauthRequiredError extends Error {
  constructor(message = "Pairing required") {
    super(message);
  }
}

export class GatewayConnectionError extends Error {
  constructor(message = "Unable to reach your Codex gateway. Make sure Tailscale is ON on both devices, then try again.") {
    super(message);
  }
}

export class ApiHttpError extends Error {
  status: number;
  body: string;

  constructor(status: number, body: string) {
    super(body || `Request failed with ${status}`);
    this.status = status;
    this.body = body;
  }
}

function isLikelyNetworkUnreachableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("network request failed") ||
    message.includes("failed to fetch") ||
    message.includes("fetch failed") ||
    message.includes("internet connection appears to be offline")
  );
}

function toGatewayConnectionError(error: unknown): never {
  if (isLikelyNetworkUnreachableError(error)) {
    throw new GatewayConnectionError();
  }
  throw error;
}

async function readErrorDetails(response: Response): Promise<string> {
  const raw = (await response.text()).trim();
  if (!raw) {
    return "";
  }

  try {
    const parsed = JSON.parse(raw) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim().length > 0) {
      return parsed.error.trim();
    }
    if (typeof parsed.message === "string" && parsed.message.trim().length > 0) {
      return parsed.message.trim();
    }
  } catch {
    // Non-JSON error body; use raw text.
  }

  return raw;
}

function joinBaseUrlAndPath(serverBaseUrl: string, pathname: string): string {
  const normalizedBase = normalizeBaseUrl(serverBaseUrl);
  return `${normalizedBase}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
}

function hasBasePath(serverBaseUrl: string): boolean {
  try {
    const pathname = new URL(serverBaseUrl).pathname.replace(/\/+$/, "");
    return pathname.length > 0 && pathname !== "/";
  } catch {
    return false;
  }
}

function appendBasePath(serverBaseUrl: string, basePath: string): string {
  const normalizedBasePath = basePath.startsWith("/") ? basePath : `/${basePath}`;
  return normalizeBaseUrl(`${normalizeBaseUrl(serverBaseUrl)}${normalizedBasePath}`);
}

function normalizeBaseUrl(value: string): string {
  const parsed = new URL(value);
  const normalizedPath = parsed.pathname.replace(/\/+$/, "");
  const basePath = normalizedPath === "/" ? "" : normalizedPath;
  return `${parsed.protocol}//${parsed.host}${basePath}`;
}

function hostFromBaseUrl(serverBaseUrl: string): string {
  try {
    return new URL(serverBaseUrl).host;
  } catch {
    return serverBaseUrl;
  }
}

function createGatewayId(serverBaseUrl: string): GatewayId {
  return normalizeBaseUrl(serverBaseUrl).toLowerCase();
}

function normalizeNicknameInput(nickname: string): string {
  return nickname.trim().slice(0, MAX_GATEWAY_NICKNAME_LENGTH);
}

function defaultNicknameForBaseUrl(serverBaseUrl: string): string {
  const host = hostFromBaseUrl(serverBaseUrl).trim();
  if (host.length > 0) {
    return host.slice(0, MAX_GATEWAY_NICKNAME_LENGTH);
  }
  return serverBaseUrl.slice(0, MAX_GATEWAY_NICKNAME_LENGTH);
}

function normalizeRecord(record: GatewayRecord): GatewayRecord {
  const normalizedBaseUrl = normalizeBaseUrl(record.serverBaseUrl);
  const normalizedId = createGatewayId(normalizedBaseUrl);
  const pairedAt = Number.isFinite(record.pairedAt) ? record.pairedAt : Date.now();
  const lastUsedAt = Number.isFinite(record.lastUsedAt) ? record.lastUsedAt : pairedAt;
  const nickname = normalizeNicknameInput(record.nickname) || defaultNicknameForBaseUrl(normalizedBaseUrl);

  return {
    ...record,
    id: normalizedId,
    serverBaseUrl: normalizedBaseUrl,
    nickname,
    pairedAt,
    lastUsedAt,
  };
}

async function updateGatewayBaseUrl(gatewayId: GatewayId, serverBaseUrl: string): Promise<GatewayRecord | null> {
  const store = await loadGatewayStore();
  let updatedGateway: GatewayRecord | null = null;

  const gateways = store.gateways.map((gateway) => {
    if (gateway.id !== gatewayId) {
      return gateway;
    }

    updatedGateway = normalizeRecord({
      ...gateway,
      serverBaseUrl,
    });
    return updatedGateway;
  });

  if (!updatedGateway) {
    return null;
  }

  const finalizedGateway = updatedGateway as GatewayRecord;

  await persistGatewayStore({
    ...store,
    gateways,
    activeGatewayId: store.activeGatewayId === gatewayId ? finalizedGateway.id : store.activeGatewayId,
  });

  if (finalizedGateway.id !== gatewayId) {
    const cachedToken = accessTokenByGatewayId.get(gatewayId);
    if (cachedToken !== undefined) {
      accessTokenByGatewayId.set(finalizedGateway.id, cachedToken);
      accessTokenByGatewayId.delete(gatewayId);
    }
    const inFlightRefresh = refreshPromiseByGatewayId.get(gatewayId);
    if (inFlightRefresh) {
      refreshPromiseByGatewayId.set(finalizedGateway.id, inFlightRefresh);
      refreshPromiseByGatewayId.delete(gatewayId);
    }
  }

  return finalizedGateway;
}

async function retryWithGatewayBasePathFallback(
  gateway: GatewayRecord,
  requestWithBaseUrl: (serverBaseUrl: string) => Promise<Response>
): Promise<{ gateway: GatewayRecord; response: Response }> {
  let response = await requestWithBaseUrl(gateway.serverBaseUrl);
  let effectiveGateway = gateway;

  if (!response.ok && PAIRING_ROUTE_MISCONFIG_STATUSES.has(response.status) && !hasBasePath(gateway.serverBaseUrl)) {
    for (const fallbackBasePath of PAIRING_ROUTE_FALLBACK_BASE_PATHS) {
      const fallbackBaseUrl = appendBasePath(gateway.serverBaseUrl, fallbackBasePath);
      if (fallbackBaseUrl === gateway.serverBaseUrl) {
        continue;
      }

      const fallbackResponse = await requestWithBaseUrl(fallbackBaseUrl);
      if (!fallbackResponse.ok && PAIRING_ROUTE_MISCONFIG_STATUSES.has(fallbackResponse.status)) {
        continue;
      }

      const updatedGateway = await updateGatewayBaseUrl(gateway.id, fallbackBaseUrl);
      effectiveGateway = updatedGateway ?? gateway;
      response = fallbackResponse;
      break;
    }
  }

  return {
    gateway: effectiveGateway,
    response,
  };
}

function normalizeGatewayStore(raw: unknown): GatewayStoreV1 {
  const base: GatewayStoreV1 = {
    version: 1,
    activeGatewayId: null,
    gateways: [],
  };

  if (!raw || typeof raw !== "object") {
    return base;
  }

  const record = raw as Record<string, unknown>;
  const gatewaysRaw = Array.isArray(record.gateways) ? record.gateways : [];
  const dedupedById = new Map<GatewayId, GatewayRecord>();

  for (const entry of gatewaysRaw) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const row = entry as Record<string, unknown>;
    const serverBaseUrl = typeof row.serverBaseUrl === "string" ? row.serverBaseUrl : null;
    const refreshToken = typeof row.refreshToken === "string" ? row.refreshToken : null;
    if (!serverBaseUrl || !refreshToken) {
      continue;
    }

    let normalizedBaseUrl: string;
    try {
      normalizedBaseUrl = normalizeBaseUrl(serverBaseUrl);
    } catch {
      continue;
    }

    const normalized = normalizeRecord({
      id: typeof row.id === "string" && row.id.trim().length > 0 ? row.id.trim() : createGatewayId(normalizedBaseUrl),
      serverBaseUrl: normalizedBaseUrl,
      refreshToken,
      nickname:
        typeof row.nickname === "string" && row.nickname.trim().length > 0
          ? row.nickname
          : defaultNicknameForBaseUrl(normalizedBaseUrl),
      serverInfoName: typeof row.serverInfoName === "string" ? row.serverInfoName : undefined,
      serverInfoVersion: typeof row.serverInfoVersion === "string" ? row.serverInfoVersion : undefined,
      pairedAt: typeof row.pairedAt === "number" ? row.pairedAt : Date.now(),
      lastUsedAt: typeof row.lastUsedAt === "number" ? row.lastUsedAt : Date.now(),
    });

    const existing = dedupedById.get(normalized.id);
    if (!existing || normalized.lastUsedAt >= existing.lastUsedAt) {
      dedupedById.set(normalized.id, normalized);
    }
  }

  const gateways = Array.from(dedupedById.values()).sort((left, right) => {
    if (left.lastUsedAt !== right.lastUsedAt) {
      return right.lastUsedAt - left.lastUsedAt;
    }
    return left.id.localeCompare(right.id);
  });

  const activeGatewayId =
    typeof record.activeGatewayId === "string" && gateways.some((gateway) => gateway.id === record.activeGatewayId)
      ? record.activeGatewayId
      : gateways[0]?.id ?? null;

  return {
    version: 1,
    activeGatewayId,
    gateways,
  };
}

function toGatewaySummary(record: GatewayRecord, activeGatewayId: GatewayId | null): GatewaySummary {
  return {
    id: record.id,
    nickname: record.nickname,
    serverBaseUrl: record.serverBaseUrl,
    host: hostFromBaseUrl(record.serverBaseUrl),
    isActive: activeGatewayId === record.id,
    pairedAt: record.pairedAt,
    lastUsedAt: record.lastUsedAt,
  };
}

async function persistGatewayStore(next: GatewayStoreV1) {
  const normalized = normalizeGatewayStore(next);
  gatewayStoreCache = normalized;
  gatewayStoreLoaded = true;
  await SecureStore.setItemAsync(GATEWAY_STORE_KEY, JSON.stringify(normalized));
}

async function migrateLegacySessionIfNeeded(): Promise<GatewayStoreV1> {
  const [serverBaseUrl, refreshToken] = await Promise.all([
    SecureStore.getItemAsync(LEGACY_SERVER_BASE_URL_KEY),
    SecureStore.getItemAsync(LEGACY_REFRESH_TOKEN_KEY),
  ]);

  if (!serverBaseUrl || !refreshToken) {
    return {
      version: 1,
      activeGatewayId: null,
      gateways: [],
    };
  }

  let normalizedBaseUrl: string;
  try {
    normalizedBaseUrl = normalizeBaseUrl(serverBaseUrl);
  } catch {
    await Promise.all([
      SecureStore.deleteItemAsync(LEGACY_SERVER_BASE_URL_KEY),
      SecureStore.deleteItemAsync(LEGACY_REFRESH_TOKEN_KEY),
    ]);
    return {
      version: 1,
      activeGatewayId: null,
      gateways: [],
    };
  }

  const now = Date.now();
  const gatewayId = createGatewayId(normalizedBaseUrl);
  const migrated: GatewayStoreV1 = {
    version: 1,
    activeGatewayId: gatewayId,
    gateways: [
      {
        id: gatewayId,
        serverBaseUrl: normalizedBaseUrl,
        refreshToken,
        nickname: defaultNicknameForBaseUrl(normalizedBaseUrl),
        pairedAt: now,
        lastUsedAt: now,
      },
    ],
  };

  await Promise.all([
    SecureStore.deleteItemAsync(LEGACY_SERVER_BASE_URL_KEY),
    SecureStore.deleteItemAsync(LEGACY_REFRESH_TOKEN_KEY),
  ]);

  return migrated;
}

async function loadGatewayStore(): Promise<GatewayStoreV1> {
  if (gatewayStoreLoaded && gatewayStoreCache) {
    return gatewayStoreCache;
  }

  const stored = await SecureStore.getItemAsync(GATEWAY_STORE_KEY);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as unknown;
      const normalized = normalizeGatewayStore(parsed);
      gatewayStoreCache = normalized;
      gatewayStoreLoaded = true;
      return normalized;
    } catch {
      // fall through to migration/default
    }
  }

  const migrated = await migrateLegacySessionIfNeeded();
  await persistGatewayStore(migrated);
  return migrated;
}

async function getGatewayRecordById(gatewayId: GatewayId): Promise<GatewayRecord | null> {
  const store = await loadGatewayStore();
  return store.gateways.find((gateway) => gateway.id === gatewayId) ?? null;
}

async function resolveGatewayRecord(gatewayId?: GatewayId): Promise<GatewayRecord> {
  const store = await loadGatewayStore();
  const targetGatewayId = gatewayId ?? store.activeGatewayId;
  if (!targetGatewayId) {
    throw new ReauthRequiredError();
  }
  const target = store.gateways.find((gateway) => gateway.id === targetGatewayId);
  if (!target) {
    throw new ReauthRequiredError();
  }
  return target;
}

async function removeGatewayInternal(gatewayId: GatewayId): Promise<{ remaining: number; activeGatewayId: GatewayId | null }> {
  const store = await loadGatewayStore();
  const exists = store.gateways.some((gateway) => gateway.id === gatewayId);
  if (!exists) {
    return {
      remaining: store.gateways.length,
      activeGatewayId: store.activeGatewayId,
    };
  }

  const gateways = store.gateways.filter((gateway) => gateway.id !== gatewayId);
  const nextActiveGatewayId =
    store.activeGatewayId === gatewayId
      ? gateways
          .slice()
          .sort((left, right) => {
            if (left.lastUsedAt !== right.lastUsedAt) {
              return right.lastUsedAt - left.lastUsedAt;
            }
            return left.id.localeCompare(right.id);
          })[0]?.id ?? null
      : store.activeGatewayId;

  await persistGatewayStore({
    version: 1,
    activeGatewayId: nextActiveGatewayId,
    gateways,
  });

  accessTokenByGatewayId.delete(gatewayId);
  refreshPromiseByGatewayId.delete(gatewayId);

  return {
    remaining: gateways.length,
    activeGatewayId: nextActiveGatewayId,
  };
}

async function markGatewayAsUsed(gatewayId: GatewayId) {
  const store = await loadGatewayStore();
  const now = Date.now();
  let changed = false;

  const gateways = store.gateways.map((gateway) => {
    if (gateway.id !== gatewayId) {
      return gateway;
    }

    if (now - gateway.lastUsedAt < GATEWAY_LAST_USED_PERSIST_INTERVAL_MS) {
      return gateway;
    }

    changed = true;
    return {
      ...gateway,
      lastUsedAt: now,
    };
  });

  if (!changed) {
    return;
  }

  await persistGatewayStore({
    ...store,
    gateways,
    activeGatewayId: store.activeGatewayId ?? gatewayId,
  });
}

export async function clearSession() {
  const activeGatewayId = await getActiveGatewayId();
  if (!activeGatewayId) {
    return;
  }
  await removeGatewayInternal(activeGatewayId);
}

export async function listGateways(): Promise<GatewaySummary[]> {
  const store = await loadGatewayStore();
  return store.gateways
    .slice()
    .sort((left, right) => {
      if (left.lastUsedAt !== right.lastUsedAt) {
        return right.lastUsedAt - left.lastUsedAt;
      }
      if (left.pairedAt !== right.pairedAt) {
        return right.pairedAt - left.pairedAt;
      }
      return left.id.localeCompare(right.id);
    })
    .map((gateway) => toGatewaySummary(gateway, store.activeGatewayId));
}

export async function getGatewayById(gatewayId: GatewayId): Promise<GatewaySummary | null> {
  const store = await loadGatewayStore();
  const gateway = store.gateways.find((entry) => entry.id === gatewayId);
  if (!gateway) {
    return null;
  }
  return toGatewaySummary(gateway, store.activeGatewayId);
}

export async function getActiveGatewayId(): Promise<GatewayId | null> {
  const store = await loadGatewayStore();
  return store.activeGatewayId;
}

export async function setActiveGateway(gatewayId: GatewayId): Promise<void> {
  const store = await loadGatewayStore();
  if (!store.gateways.some((gateway) => gateway.id === gatewayId)) {
    throw new Error("Gateway not found");
  }

  const now = Date.now();
  const gateways = store.gateways.map((gateway) =>
    gateway.id === gatewayId
      ? {
          ...gateway,
          lastUsedAt: now,
        }
      : gateway
  );

  await persistGatewayStore({
    version: 1,
    activeGatewayId: gatewayId,
    gateways,
  });
}

export async function renameGateway(gatewayId: GatewayId, nickname: string): Promise<void> {
  const store = await loadGatewayStore();
  const normalizedNickname = normalizeNicknameInput(nickname);
  if (!normalizedNickname) {
    throw new Error("Gateway nickname is required");
  }

  let found = false;
  const gateways = store.gateways.map((gateway) => {
    if (gateway.id !== gatewayId) {
      return gateway;
    }
    found = true;
    return {
      ...gateway,
      nickname: normalizedNickname,
    };
  });

  if (!found) {
    throw new Error("Gateway not found");
  }

  await persistGatewayStore({
    ...store,
    gateways,
  });
}

export async function removeGateway(gatewayId: GatewayId): Promise<{ remaining: number; activeGatewayId: GatewayId | null }> {
  return removeGatewayInternal(gatewayId);
}

export async function logoutGateway(gatewayId: GatewayId): Promise<void> {
  const gateway = await getGatewayRecordById(gatewayId);
  if (!gateway) {
    return;
  }

  let response: Response;
  try {
    response = await fetch(`${gateway.serverBaseUrl}/auth/logout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        refreshToken: gateway.refreshToken,
      }),
    });
  } catch (error) {
    toGatewayConnectionError(error);
  }

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Logout failed: ${details || response.status}`);
  }
}

export async function hasStoredPairing(): Promise<boolean> {
  const store = await loadGatewayStore();
  return store.gateways.length > 0;
}

export async function getCurrentServerBaseUrl(): Promise<string | null> {
  const store = await loadGatewayStore();
  if (!store.activeGatewayId) {
    return null;
  }
  return store.gateways.find((gateway) => gateway.id === store.activeGatewayId)?.serverBaseUrl ?? null;
}

export function parsePairingUrl(rawUrl: string): { serverBaseUrl: string; pairId: string; code: string } {
  const url = new URL(rawUrl);
  const pairId = url.searchParams.get("pairId");
  const code = url.searchParams.get("code");

  if (!pairId || !code) {
    throw new Error("QR code is missing pairing parameters");
  }

  const normalizedPath = url.pathname.replace(/\/+$/, "");
  const marker = "/pair/claim";
  const markerIndex = normalizedPath.toLowerCase().lastIndexOf(marker);
  const basePath = markerIndex >= 0 ? normalizedPath.slice(0, markerIndex) : "";

  return {
    serverBaseUrl: normalizeBaseUrl(`${url.protocol}//${url.host}${basePath}`),
    pairId,
    code,
  };
}

export async function claimPairing(
  pairing: { serverBaseUrl: string; pairId: string; code: string },
  payload: Pick<PairClaimRequest, "deviceId" | "deviceName">
): Promise<{ gatewayId: GatewayId } & ReturnType<typeof PairClaimResponseSchema.parse>> {
  const requestBody = JSON.stringify({
    pairId: pairing.pairId,
    code: pairing.code,
    deviceId: payload.deviceId,
    deviceName: payload.deviceName,
  });

  const requestPairClaim = async (serverBaseUrl: string): Promise<Response> => {
    try {
      return await fetch(joinBaseUrlAndPath(serverBaseUrl, "/pair/claim"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: requestBody,
      });
    } catch (error) {
      toGatewayConnectionError(error);
    }
  };

  const parsePairClaimResponse = async (
    response: Response
  ): Promise<
    | { ok: true; value: ReturnType<typeof PairClaimResponseSchema.parse> }
    | { ok: false; error: unknown }
  > => {
    try {
      return {
        ok: true,
        value: PairClaimResponseSchema.parse(await response.json()),
      };
    } catch (error) {
      return {
        ok: false,
        error,
      };
    }
  };

  let effectiveServerBaseUrl = normalizeBaseUrl(pairing.serverBaseUrl);
  let response = await requestPairClaim(effectiveServerBaseUrl);

  if (!response.ok && PAIRING_ROUTE_MISCONFIG_STATUSES.has(response.status) && !hasBasePath(effectiveServerBaseUrl)) {
    for (const fallbackBasePath of PAIRING_ROUTE_FALLBACK_BASE_PATHS) {
      const fallbackBaseUrl = appendBasePath(effectiveServerBaseUrl, fallbackBasePath);
      if (fallbackBaseUrl === effectiveServerBaseUrl) {
        continue;
      }

      try {
        const fallbackResponse = await requestPairClaim(fallbackBaseUrl);
        if (fallbackResponse.ok || !PAIRING_ROUTE_MISCONFIG_STATUSES.has(fallbackResponse.status)) {
          effectiveServerBaseUrl = fallbackBaseUrl;
          response = fallbackResponse;
          break;
        }
      } catch {
        // Try the next fallback base path.
      }
    }
  }

  if (!response.ok) {
    if (PAIRING_ROUTE_MISCONFIG_STATUSES.has(response.status)) {
      throw new Error(
        "Pairing failed: gateway URL is not routing to the gateway. Run `tailscale serve --bg --set-path /codex-gateway http://127.0.0.1:8787` (or map `/` to 127.0.0.1:8787) and retry."
      );
    }
    const details = await readErrorDetails(response);
    const suffix = details || `HTTP ${response.status}`;
    throw new Error(`Pairing failed (${response.status}): ${suffix}`);
  }

  let parsedResult = await parsePairClaimResponse(response);

  if (!parsedResult.ok && !hasBasePath(effectiveServerBaseUrl)) {
    for (const fallbackBasePath of PAIRING_ROUTE_FALLBACK_BASE_PATHS) {
      const fallbackBaseUrl = appendBasePath(effectiveServerBaseUrl, fallbackBasePath);
      if (fallbackBaseUrl === effectiveServerBaseUrl) {
        continue;
      }

      try {
        const fallbackResponse = await requestPairClaim(fallbackBaseUrl);
        if (!fallbackResponse.ok) {
          continue;
        }

        const fallbackParsedResult = await parsePairClaimResponse(fallbackResponse);
        if (!fallbackParsedResult.ok) {
          continue;
        }

        effectiveServerBaseUrl = fallbackBaseUrl;
        response = fallbackResponse;
        parsedResult = fallbackParsedResult;
        break;
      } catch {
        // Try the next fallback base path.
      }
    }
  }

  if (!parsedResult.ok) {
    throw parsedResult.error instanceof Error
      ? parsedResult.error
      : new Error("Pairing failed: gateway returned an invalid response.");
  }

  const parsed = parsedResult.value;
  const store = await loadGatewayStore();
  const normalizedBaseUrl = normalizeBaseUrl(effectiveServerBaseUrl);
  const gatewayId = createGatewayId(normalizedBaseUrl);
  const now = Date.now();

  let found = false;
  const gateways = store.gateways.map((gateway) => {
    if (gateway.id !== gatewayId) {
      return gateway;
    }

    found = true;
    return {
      ...gateway,
      serverBaseUrl: normalizedBaseUrl,
      refreshToken: parsed.refreshToken,
      serverInfoName: parsed.serverInfo.name,
      serverInfoVersion: parsed.serverInfo.version,
      lastUsedAt: now,
    };
  });

  if (!found) {
    gateways.push({
      id: gatewayId,
      serverBaseUrl: normalizedBaseUrl,
      refreshToken: parsed.refreshToken,
      nickname: defaultNicknameForBaseUrl(normalizedBaseUrl),
      serverInfoName: parsed.serverInfo.name,
      serverInfoVersion: parsed.serverInfo.version,
      pairedAt: now,
      lastUsedAt: now,
    });
  }

  await persistGatewayStore({
    version: 1,
    activeGatewayId: gatewayId,
    gateways,
  });

  accessTokenByGatewayId.set(gatewayId, parsed.accessToken);

  return {
    gatewayId,
    ...parsed,
  };
}

async function refreshAccessToken(gatewayId?: GatewayId): Promise<string> {
  const gateway = await resolveGatewayRecord(gatewayId);
  const inFlight = refreshPromiseByGatewayId.get(gateway.id);
  if (inFlight) {
    return inFlight;
  }

  const promise = (async () => {
    const { gateway: effectiveGateway, response } = await retryWithGatewayBasePathFallback(gateway, async (serverBaseUrl) => {
      try {
        return await fetch(`${serverBaseUrl}/auth/refresh`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            refreshToken: gateway.refreshToken,
          }),
        });
      } catch (error) {
        toGatewayConnectionError(error);
      }
    });

    if (!response.ok) {
      await removeGatewayInternal(effectiveGateway.id);
      throw new ReauthRequiredError("Refresh token rejected");
    }

    const payload = AuthRefreshResponseSchema.parse(await response.json());
    accessTokenByGatewayId.set(effectiveGateway.id, payload.accessToken);
    return payload.accessToken;
  })().finally(() => {
    refreshPromiseByGatewayId.delete(gateway.id);
  });

  refreshPromiseByGatewayId.set(gateway.id, promise);
  return promise;
}

async function getValidAccessToken(gatewayId?: GatewayId): Promise<{ gateway: GatewayRecord; accessToken: string }> {
  const gateway = await resolveGatewayRecord(gatewayId);
  const cachedToken = accessTokenByGatewayId.get(gateway.id);
  if (typeof cachedToken === "string" && cachedToken.length > 0) {
    return {
      gateway,
      accessToken: cachedToken,
    };
  }

  const accessToken = await refreshAccessToken(gateway.id);
  return {
    gateway,
    accessToken,
  };
}

async function buildUrl(pathname: string, gatewayId?: GatewayId): Promise<{ url: string; gateway: GatewayRecord }> {
  const gateway = await resolveGatewayRecord(gatewayId);
  return {
    gateway,
    url: `${gateway.serverBaseUrl}${pathname.startsWith("/") ? pathname : `/${pathname}`}`,
  };
}

export async function authenticatedRequest<T>(
  pathname: string,
  options: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {},
  gatewayId?: GatewayId
): Promise<T> {
  const gateway = await resolveGatewayRecord(gatewayId);
  let { accessToken } = await getValidAccessToken(gateway.id);

  const doRequest = async (token: string, serverBaseUrl: string) => {
    try {
      return await fetch(joinBaseUrlAndPath(serverBaseUrl, pathname), {
        ...options,
        headers: {
          ...(options.headers ?? {}),
          Authorization: `Bearer ${token}`,
        },
      });
    } catch (error) {
      toGatewayConnectionError(error);
    }
  };

  let requestResult = await retryWithGatewayBasePathFallback(gateway, (serverBaseUrl) => doRequest(accessToken, serverBaseUrl));
  let response = requestResult.response;
  let effectiveGateway = requestResult.gateway;

  if (response.status === 401) {
    accessToken = await refreshAccessToken(effectiveGateway.id);
    requestResult = await retryWithGatewayBasePathFallback(effectiveGateway, (serverBaseUrl) => doRequest(accessToken, serverBaseUrl));
    response = requestResult.response;
    effectiveGateway = requestResult.gateway;
  }

  if (response.status === 401) {
    await removeGatewayInternal(effectiveGateway.id);
    throw new ReauthRequiredError();
  }

  if (!response.ok) {
    const body = await response.text();
    throw new ApiHttpError(response.status, body);
  }

  await markGatewayAsUsed(effectiveGateway.id);

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export async function getThreads(gatewayId?: GatewayId) {
  const payload = await authenticatedRequest<unknown>("/threads", {}, gatewayId);
  return ThreadsResponseSchema.parse(payload);
}

export async function getThread(threadId: string, gatewayId?: GatewayId) {
  const payload = await authenticatedRequest<unknown>(`/threads/${encodeURIComponent(threadId)}`, {}, gatewayId);
  return ThreadResponseSchema.parse(payload);
}

export async function getThreadEvents(threadId: string, gatewayId?: GatewayId) {
  const payload = await authenticatedRequest<unknown>(`/threads/${encodeURIComponent(threadId)}/events`, {}, gatewayId);
  return ThreadEventsResponseSchema.parse(payload);
}

export async function createThread(request?: ThreadCreateRequest, gatewayId?: GatewayId) {
  const payload = await authenticatedRequest<unknown>(
    "/threads",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request ?? {}),
    },
    gatewayId
  );
  return ThreadCreateResponseSchema.parse(payload);
}

export async function getWorkspaces(gatewayId?: GatewayId) {
  const payload = await authenticatedRequest<unknown>("/workspaces", {}, gatewayId);
  return WorkspacesResponseSchema.parse(payload);
}

export async function getDirectories(pathValue?: string, gatewayId?: GatewayId) {
  const query = pathValue ? `?path=${encodeURIComponent(pathValue)}` : "";
  const payload = await authenticatedRequest<unknown>(`/directories${query}`, {}, gatewayId);
  return DirectoryBrowseResponseSchema.parse(payload);
}

export async function createDirectory(request: DirectoryCreateRequest, gatewayId?: GatewayId) {
  const payload = await authenticatedRequest<unknown>(
    "/directories",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    },
    gatewayId
  );
  return DirectoryCreateResponseSchema.parse(payload);
}

export async function getThreadFiles(threadId: string, params?: { query?: string; limit?: number }, gatewayId?: GatewayId) {
  const queryParams = new URLSearchParams();
  if (params?.query) {
    queryParams.set("query", params.query);
  }
  if (typeof params?.limit === "number" && Number.isFinite(params.limit)) {
    queryParams.set("limit", String(Math.max(1, Math.floor(params.limit))));
  }
  const querySuffix = queryParams.toString().length > 0 ? `?${queryParams.toString()}` : "";
  const payload = await authenticatedRequest<unknown>(
    `/threads/${encodeURIComponent(threadId)}/files${querySuffix}`,
    {},
    gatewayId
  );
  return ThreadFilesResponseSchema.parse(payload);
}

export async function resumeThread(threadId: string, gatewayId?: GatewayId) {
  const payload = await authenticatedRequest<unknown>(
    `/threads/${encodeURIComponent(threadId)}/resume`,
    {
      method: "POST",
    },
    gatewayId
  );
  return ThreadResumeResponseSchema.parse(payload);
}

export async function getThreadGoal(threadId: string, gatewayId?: GatewayId) {
  const payload = await authenticatedRequest<unknown>(`/threads/${encodeURIComponent(threadId)}/goal`, {}, gatewayId);
  return ThreadGoalResponseSchema.parse(payload);
}

export async function setThreadGoal(threadId: string, request: ThreadGoalSetRequest, gatewayId?: GatewayId) {
  const payload = await authenticatedRequest<unknown>(
    `/threads/${encodeURIComponent(threadId)}/goal`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    },
    gatewayId
  );
  return ThreadGoalResponseSchema.parse(payload);
}

export async function clearThreadGoal(threadId: string, gatewayId?: GatewayId) {
  const payload = await authenticatedRequest<unknown>(
    `/threads/${encodeURIComponent(threadId)}/goal`,
    {
      method: "DELETE",
    },
    gatewayId
  );
  return ThreadGoalClearResponseSchema.parse(payload);
}

export async function sendThreadMessage(threadId: string, request: ThreadMessageRequest, gatewayId?: GatewayId) {
  const payload = await authenticatedRequest<unknown>(
    `/threads/${encodeURIComponent(threadId)}/message`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    },
    gatewayId
  );

  return ThreadMessageResponseSchema.parse(payload);
}

export async function getQueuedThreadMessages(threadId: string, gatewayId?: GatewayId) {
  const payload = await authenticatedRequest<unknown>(
    `/threads/${encodeURIComponent(threadId)}/messages/queue`,
    {},
    gatewayId
  );
  return QueuedThreadMessagesResponseSchema.parse(payload).messages;
}

export async function queueThreadMessage(threadId: string, request: ThreadMessageRequest, gatewayId?: GatewayId) {
  const payload = await authenticatedRequest<unknown>(
    `/threads/${encodeURIComponent(threadId)}/messages/queue`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    },
    gatewayId
  );
  return QueuedThreadMessageEnqueueResponseSchema.parse(payload);
}

export async function removeQueuedThreadMessage(threadId: string, queuedMessageId: string, gatewayId?: GatewayId) {
  const payload = await authenticatedRequest<unknown>(
    `/threads/${encodeURIComponent(threadId)}/messages/queue/${encodeURIComponent(queuedMessageId)}`,
    {
      method: "DELETE",
    },
    gatewayId
  );
  return QueuedThreadMessageRemoveResponseSchema.parse(payload);
}

export async function steerQueuedThreadMessage(threadId: string, queuedMessageId: string, gatewayId?: GatewayId) {
  const payload = await authenticatedRequest<unknown>(
    `/threads/${encodeURIComponent(threadId)}/messages/queue/${encodeURIComponent(queuedMessageId)}/steer`,
    {
      method: "POST",
    },
    gatewayId
  );
  return QueuedThreadMessageSteerResponseSchema.parse(payload);
}

export async function interruptThreadTurn(threadId: string, request: ThreadInterruptRequest, gatewayId?: GatewayId) {
  const payload = await authenticatedRequest<unknown>(
    `/threads/${encodeURIComponent(threadId)}/interrupt`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    },
    gatewayId
  );

  return ThreadInterruptResponseSchema.parse(payload);
}

export async function getStreamConfig(threadId: string, gatewayId?: GatewayId): Promise<{ wsUrl: string; token: string }> {
  const gateway = await resolveGatewayRecord(gatewayId);
  const { accessToken } = await getValidAccessToken(gateway.id);
  const httpUrl = `${gateway.serverBaseUrl}/threads/${encodeURIComponent(threadId)}/ws`;
  const wsUrl = `${httpUrl.replace(/^http:\/\//i, "ws://").replace(/^https:\/\//i, "wss://")}?access_token=${encodeURIComponent(accessToken)}`;
  return {
    wsUrl,
    token: accessToken,
  };
}

export async function getGatewayOptions(gatewayId?: GatewayId) {
  const payload = await authenticatedRequest<unknown>("/options", {}, gatewayId);
  return GatewayOptionsResponseSchema.parse(payload);
}

export async function getInteractiveRequests(threadId?: string, gatewayId?: GatewayId) {
  const pathname = threadId
    ? `/threads/${encodeURIComponent(threadId)}/interactive-requests`
    : "/interactive-requests";
  const payload = await authenticatedRequest<unknown>(pathname, {}, gatewayId);
  return InteractiveRequestsResponseSchema.parse(payload);
}

export async function respondToInteractiveRequest(requestId: string, result: unknown, gatewayId?: GatewayId) {
  const payload = await authenticatedRequest<unknown>(
    `/interactive-requests/${encodeURIComponent(requestId)}/respond`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ result }),
    },
    gatewayId
  );
  return InteractiveRequestRespondResponseSchema.parse(payload);
}

export async function getPairedDevices(gatewayId?: GatewayId) {
  const payload = await authenticatedRequest<unknown>("/devices/active", {}, gatewayId);
  return PairedDevicesResponseSchema.parse(payload);
}

export async function upsertPushToken(
  request: { token: string; platform: "ios" | "android"; enabled?: boolean },
  gatewayId?: GatewayId
) {
  const payload = await authenticatedRequest<unknown>(
    "/notifications/push-token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    },
    gatewayId
  );
  return PushTokenUpsertResponseSchema.parse(payload);
}

export async function upsertAppPresence(request: { state: "active" | "background" | "inactive" }, gatewayId?: GatewayId) {
  const payload = await authenticatedRequest<unknown>(
    "/presence/app-state",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    },
    gatewayId
  );
  return AppPresenceUpsertResponseSchema.parse(payload);
}
