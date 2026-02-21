import { EventEmitter } from "node:events";
import WebSocket from "ws";

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

type JsonRpcId = number | string;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeout: NodeJS.Timeout;
}

type ThreadListener = (payload: { method: string; params: unknown }) => void;
type ServerRequestHandler = (payload: { id: JsonRpcId; method: string; params: unknown }) => unknown | Promise<unknown>;

const THREAD_ID_KEYS = ["threadId", "thread_id", "threadID", "id"];

export class CodexRpcClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private requestId = 1;
  private initialized = false;
  private pending = new Map<number, PendingRequest>();
  private threadListeners = new Map<string, Set<ThreadListener>>();
  private serverRequestHandler: ServerRequestHandler | null = null;

  constructor(
    private readonly url: string,
    private readonly clientName: string,
    private readonly clientVersion: string
  ) {
    super();
  }

  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.initialized) {
      return;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url, {
        perMessageDeflate: false,
      });
      let settled = false;

      socket.on("open", async () => {
        this.ws = socket;
        try {
          await this.initializeSession();
          settled = true;
          resolve();
        } catch (error) {
          settled = true;
          reject(error);
        }
      });

      socket.on("message", (raw) => {
        this.handleMessage(raw.toString());
      });

      socket.on("close", () => {
        this.ws = null;
        this.initialized = false;
        this.failPending(new Error("Codex app-server connection closed"));
        this.connectPromise = null;
      });

      socket.on("error", (error) => {
        if (!settled) {
          reject(error);
        }
      });
    }).finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  async call(method: string, params?: unknown): Promise<unknown> {
    await this.connect();
    return this.sendRequest(method, params);
  }

  async reconnect(): Promise<void> {
    const socket = this.ws;
    this.ws = null;
    this.initialized = false;
    this.connectPromise = null;
    if (socket && socket.readyState === WebSocket.OPEN) {
      try {
        socket.terminate();
      } catch {
        // ignore close errors
      }
    }
    await this.connect();
  }

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    const handler = (payload: { method: string; params: unknown }) => {
      listener(payload.method, payload.params);
    };
    this.on("notification", handler);
    return () => {
      this.off("notification", handler);
    };
  }

  setServerRequestHandler(handler: ServerRequestHandler | null) {
    this.serverRequestHandler = handler;
  }

  subscribeThread(threadId: string, listener: ThreadListener): () => void {
    const listeners = this.threadListeners.get(threadId) ?? new Set<ThreadListener>();
    listeners.add(listener);
    this.threadListeners.set(threadId, listeners);
    return () => {
      const current = this.threadListeners.get(threadId);
      if (!current) {
        return;
      }
      current.delete(listener);
      if (current.size === 0) {
        this.threadListeners.delete(threadId);
      }
    };
  }

  private async initializeSession() {
    if (this.initialized) {
      return;
    }

    try {
      await this.sendRequest("initialize", {
        clientInfo: {
          name: this.clientName,
          version: this.clientVersion,
        },
        capabilities: null,
      });
    } catch {
      // Not all Codex builds expose initialize; continue with a best effort session.
    }

    this.sendNotification("initialized");
    this.initialized = true;
  }

  private sendNotification(method: string, params?: unknown) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  private sendRequest(method: string, params?: unknown): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Codex app-server is not connected"));
    }

    const id = this.requestId;
    this.requestId += 1;

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`JSON-RPC timeout for method '${method}'`));
      }, 15_000);

      this.pending.set(id, { resolve, reject, timeout });
      this.ws?.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  private handleMessage(raw: string) {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (!message || typeof message !== "object") {
      return;
    }

    const record = message as Record<string, unknown>;
    if (typeof record.method === "string") {
      // A message with method is either a notification (no id) or server-initiated request (has id).
      if (typeof record.id === "number" || typeof record.id === "string") {
        this.handleServerRequest({
          id: record.id,
          method: record.method,
          params: record.params,
        });
        return;
      }

      const payload = {
        method: record.method,
        params: record.params,
      };

      this.emit("notification", payload);
      this.dispatchToThreadListeners(payload);
      return;
    }

    const maybeId = record.id;
    if (typeof maybeId === "number" || typeof maybeId === "string") {
      if (typeof maybeId === "number") {
        const pending = this.pending.get(maybeId);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pending.delete(maybeId);
          const error = record.error;
          if (error && typeof error === "object" && typeof (error as JsonRpcError).message === "string") {
            pending.reject(new Error((error as JsonRpcError).message));
          } else {
            pending.resolve(record.result);
          }
          return;
        }
      }
      return;
    }
  }

  private handleServerRequest(payload: { id: JsonRpcId; method: string; params: unknown }) {
    const handler = this.serverRequestHandler;
    if (!handler) {
      this.sendErrorResponse(
        payload.id,
        -32000,
        `Unsupported server request '${payload.method}' for non-interactive gateway client`
      );
      return;
    }

    Promise.resolve(handler(payload))
      .then((result) => {
        this.sendResultResponse(payload.id, result ?? null);
      })
      .catch((error) => {
        const message =
          error instanceof Error && error.message
            ? error.message
            : `Failed to handle server request '${payload.method}'`;
        this.sendErrorResponse(payload.id, -32000, message);
      });
  }

  private sendResultResponse(id: JsonRpcId, result: unknown) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        result,
      })
    );
  }

  private sendErrorResponse(id: JsonRpcId, code: number, message: string, data?: unknown) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: {
          code,
          message,
          data,
        },
      })
    );
  }

  private dispatchToThreadListeners(payload: { method: string; params: unknown }) {
    const threadId = this.extractThreadId(payload.params);

    if (!threadId) {
      for (const listeners of this.threadListeners.values()) {
        for (const listener of listeners) {
          listener(payload);
        }
      }
      return;
    }

    const listeners = this.threadListeners.get(threadId);
    if (!listeners) {
      return;
    }
    for (const listener of listeners) {
      listener(payload);
    }
  }

  private extractThreadId(value: unknown): string | null {
    if (!value || typeof value !== "object") {
      return null;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const found = this.extractThreadId(item);
        if (found) {
          return found;
        }
      }
      return null;
    }

    const record = value as Record<string, unknown>;

    for (const key of THREAD_ID_KEYS) {
      const candidate = record[key];
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        return candidate;
      }
    }

    for (const nested of Object.values(record)) {
      const found = this.extractThreadId(nested);
      if (found) {
        return found;
      }
    }

    return null;
  }

  private failPending(error: Error) {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
