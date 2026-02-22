import { AppState, type AppStateStatus } from "react-native";
import { ApiHttpError, hasStoredPairing, upsertAppPresence } from "@/lib/api";

type PresenceState = "active" | "background" | "inactive";

const APP_PRESENCE_HEARTBEAT_INTERVAL_MS = 30_000;
let didWarnMissingPresenceRoute = false;

function normalizePresenceState(state: AppStateStatus): PresenceState {
  if (state === "active" || state === "background" || state === "inactive") {
    return state;
  }
  return "inactive";
}

function isMissingPresenceRouteError(error: unknown): boolean {
  if (!(error instanceof ApiHttpError) || error.status !== 404) {
    return false;
  }
  return error.body.includes("POST:/presence/app-state") && error.body.includes("not found");
}

function reportPresenceSyncError(error: unknown, state: PresenceState) {
  if (isMissingPresenceRouteError(error)) {
    if (!didWarnMissingPresenceRoute) {
      didWarnMissingPresenceRoute = true;
      console.warn(
        "App presence sync skipped: your Mac gateway is outdated and missing /presence/app-state. Rebuild/restart CodexGateway on your Mac."
      );
    }
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`App presence sync failed for state='${state}': ${message}`);
}

async function syncPresence(state: PresenceState) {
  if (!(await hasStoredPairing())) {
    return;
  }
  try {
    await upsertAppPresence({ state });
  } catch (error) {
    reportPresenceSyncError(error, state);
  }
}

export function startAppPresenceSync(): () => void {
  let disposed = false;
  let currentState = normalizePresenceState(AppState.currentState);
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  const clearHeartbeat = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const scheduleHeartbeat = () => {
    if (heartbeatTimer || currentState !== "active") {
      return;
    }
    heartbeatTimer = setInterval(() => {
      if (disposed || currentState !== "active") {
        clearHeartbeat();
        return;
      }
      void syncPresence("active");
    }, APP_PRESENCE_HEARTBEAT_INTERVAL_MS);
  };

  void syncPresence(currentState);
  scheduleHeartbeat();

  const subscription = AppState.addEventListener("change", (nextState) => {
    const normalizedState = normalizePresenceState(nextState);
    if (normalizedState === currentState) {
      return;
    }
    currentState = normalizedState;
    void syncPresence(normalizedState);
    if (normalizedState === "active") {
      scheduleHeartbeat();
      return;
    }
    clearHeartbeat();
  });

  return () => {
    disposed = true;
    clearHeartbeat();
    subscription.remove();
  };
}

export async function sendActivePresenceNowIfPaired() {
  await syncPresence("active");
}
