import {
  AuthRefreshResponseSchema,
  DirectoryBrowseResponseSchema,
  GatewayOptionsResponseSchema,
  PairedDevicesResponseSchema,
  ThreadCreateRequest,
  PairClaimRequest,
  PairClaimResponseSchema,
  ThreadMessageRequest,
  ThreadMessageResponseSchema,
  ThreadCreateResponseSchema,
  ThreadEventsResponseSchema,
  ThreadResponseSchema,
  ThreadResumeResponseSchema,
  ThreadsResponseSchema,
  WorkspacesResponseSchema,
} from "@codex-phone/shared";
import * as SecureStore from "expo-secure-store";

const SERVER_BASE_URL_KEY = "codex_phone_server_base_url";
const REFRESH_TOKEN_KEY = "codex_phone_refresh_token";

interface SessionState {
  serverBaseUrl: string;
  refreshToken: string;
  accessToken: string | null;
}

let session: SessionState | null = null;
let refreshPromise: Promise<string> | null = null;

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

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

async function loadStoredSession(): Promise<SessionState | null> {
  if (session) {
    return session;
  }

  const [serverBaseUrl, refreshToken] = await Promise.all([
    SecureStore.getItemAsync(SERVER_BASE_URL_KEY),
    SecureStore.getItemAsync(REFRESH_TOKEN_KEY),
  ]);

  if (!serverBaseUrl || !refreshToken) {
    return null;
  }

  session = {
    serverBaseUrl,
    refreshToken,
    accessToken: null,
  };

  return session;
}

async function persistSession(next: SessionState) {
  session = next;
  await Promise.all([
    SecureStore.setItemAsync(SERVER_BASE_URL_KEY, next.serverBaseUrl),
    SecureStore.setItemAsync(REFRESH_TOKEN_KEY, next.refreshToken),
  ]);
}

export async function clearSession() {
  session = null;
  refreshPromise = null;
  await Promise.all([
    SecureStore.deleteItemAsync(SERVER_BASE_URL_KEY),
    SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY),
  ]);
}

export async function hasStoredPairing(): Promise<boolean> {
  const stored = await loadStoredSession();
  return stored !== null;
}

export async function getCurrentServerBaseUrl(): Promise<string | null> {
  const stored = await loadStoredSession();
  return stored?.serverBaseUrl ?? null;
}

export function parsePairingUrl(rawUrl: string): { serverBaseUrl: string; pairId: string; code: string } {
  const url = new URL(rawUrl);
  const pairId = url.searchParams.get("pairId");
  const code = url.searchParams.get("code");

  if (!pairId || !code) {
    throw new Error("QR code is missing pairing parameters");
  }

  return {
    serverBaseUrl: normalizeBaseUrl(`${url.protocol}//${url.host}`),
    pairId,
    code,
  };
}

export async function claimPairing(
  pairing: { serverBaseUrl: string; pairId: string; code: string },
  payload: Pick<PairClaimRequest, "deviceId" | "deviceName">
) {
  let response: Response;
  try {
    response = await fetch(`${pairing.serverBaseUrl}/pair/claim`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        pairId: pairing.pairId,
        code: pairing.code,
        deviceId: payload.deviceId,
        deviceName: payload.deviceName,
      }),
    });
  } catch (error) {
    toGatewayConnectionError(error);
  }

  if (!response.ok) {
    if (response.status === 405) {
      throw new Error(
        "Pairing failed: gateway URL is not pointing to the gateway. Run `tailscale serve --bg http://127.0.0.1:8787` and retry."
      );
    }
    const details = await response.text();
    throw new Error(`Pairing failed: ${details}`);
  }

  const parsed = PairClaimResponseSchema.parse(await response.json());
  await persistSession({
    serverBaseUrl: pairing.serverBaseUrl,
    refreshToken: parsed.refreshToken,
    accessToken: parsed.accessToken,
  });

  return parsed;
}

async function refreshAccessToken(): Promise<string> {
  const current = await loadStoredSession();
  if (!current) {
    throw new ReauthRequiredError();
  }

  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    let response: Response;
    try {
      response = await fetch(`${current.serverBaseUrl}/auth/refresh`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          refreshToken: current.refreshToken,
        }),
      });
    } catch (error) {
      toGatewayConnectionError(error);
    }

    if (!response.ok) {
      await clearSession();
      throw new ReauthRequiredError("Refresh token rejected");
    }

    const payload = AuthRefreshResponseSchema.parse(await response.json());
    const next = {
      ...current,
      accessToken: payload.accessToken,
    };
    session = next;
    return payload.accessToken;
  })().finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
}

async function getValidAccessToken(): Promise<string> {
  const current = await loadStoredSession();
  if (!current) {
    throw new ReauthRequiredError();
  }

  if (current.accessToken) {
    return current.accessToken;
  }

  return refreshAccessToken();
}

async function buildUrl(pathname: string): Promise<string> {
  const current = await loadStoredSession();
  if (!current) {
    throw new ReauthRequiredError();
  }

  return `${current.serverBaseUrl}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
}

export async function authenticatedRequest<T>(
  pathname: string,
  options: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {}
): Promise<T> {
  const url = await buildUrl(pathname);
  let accessToken = await getValidAccessToken();

  const doRequest = async (token: string) => {
    try {
      return await fetch(url, {
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

  let response = await doRequest(accessToken);

  if (response.status === 401) {
    accessToken = await refreshAccessToken();
    response = await doRequest(accessToken);
  }

  if (response.status === 401) {
    await clearSession();
    throw new ReauthRequiredError();
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Request failed with ${response.status}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export async function getThreads() {
  const payload = await authenticatedRequest<unknown>("/threads");
  return ThreadsResponseSchema.parse(payload);
}

export async function getThread(threadId: string) {
  const payload = await authenticatedRequest<unknown>(`/threads/${encodeURIComponent(threadId)}`);
  return ThreadResponseSchema.parse(payload);
}

export async function getThreadEvents(threadId: string) {
  const payload = await authenticatedRequest<unknown>(`/threads/${encodeURIComponent(threadId)}/events`);
  return ThreadEventsResponseSchema.parse(payload);
}

export async function createThread(request?: ThreadCreateRequest) {
  const payload = await authenticatedRequest<unknown>("/threads", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request ?? {}),
  });
  return ThreadCreateResponseSchema.parse(payload);
}

export async function getWorkspaces() {
  const payload = await authenticatedRequest<unknown>("/workspaces");
  return WorkspacesResponseSchema.parse(payload);
}

export async function getDirectories(pathValue?: string) {
  const query = pathValue ? `?path=${encodeURIComponent(pathValue)}` : "";
  const payload = await authenticatedRequest<unknown>(`/directories${query}`);
  return DirectoryBrowseResponseSchema.parse(payload);
}

export async function resumeThread(threadId: string) {
  const payload = await authenticatedRequest<unknown>(`/threads/${encodeURIComponent(threadId)}/resume`, {
    method: "POST",
  });
  return ThreadResumeResponseSchema.parse(payload);
}

export async function sendThreadMessage(threadId: string, request: ThreadMessageRequest) {
  const payload = await authenticatedRequest<unknown>(`/threads/${encodeURIComponent(threadId)}/message`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  });

  return ThreadMessageResponseSchema.parse(payload);
}

export async function getStreamConfig(threadId: string): Promise<{ wsUrl: string; token: string }> {
  const current = await loadStoredSession();
  if (!current) {
    throw new ReauthRequiredError();
  }

  const token = await getValidAccessToken();
  const httpUrl = `${current.serverBaseUrl}/threads/${encodeURIComponent(threadId)}/ws`;
  const wsUrl = `${httpUrl.replace(/^http:\/\//i, "ws://").replace(/^https:\/\//i, "wss://")}?access_token=${encodeURIComponent(token)}`;
  return {
    wsUrl,
    token,
  };
}

export async function getGatewayOptions() {
  const payload = await authenticatedRequest<unknown>("/options");
  return GatewayOptionsResponseSchema.parse(payload);
}

export async function getPairedDevices() {
  const payload = await authenticatedRequest<unknown>("/devices/active");
  return PairedDevicesResponseSchema.parse(payload);
}
