import fs from "node:fs";
import path from "node:path";

interface RuntimeLogWriter {
  event: (type: string, data?: unknown) => void;
  error: (type: string, error: unknown, data?: unknown) => void;
}

function toJsonLine(payload: unknown): string {
  return `${JSON.stringify(payload)}\n`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeError(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return {
    name: "Error",
    message: typeof error === "string" ? error : JSON.stringify(error),
  };
}

function clip(value: unknown, maxChars = 8000): unknown {
  try {
    const text = JSON.stringify(value);
    if (text.length <= maxChars) {
      return value;
    }
    return `${text.slice(0, maxChars)}...<truncated>`;
  } catch {
    return "<unserializable>";
  }
}

export function createRuntimeLogWriter(eventsPath: string, errorsPath: string): RuntimeLogWriter {
  fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
  fs.mkdirSync(path.dirname(errorsPath), { recursive: true });
  if (!fs.existsSync(eventsPath)) {
    fs.writeFileSync(eventsPath, "", "utf8");
  }
  if (!fs.existsSync(errorsPath)) {
    fs.writeFileSync(errorsPath, "", "utf8");
  }

  const append = (targetPath: string, payload: unknown) => {
    try {
      fs.appendFileSync(targetPath, toJsonLine(payload), "utf8");
    } catch {
      // do not crash gateway due to logging IO
    }
  };

  return {
    event: (type: string, data?: unknown) => {
      append(eventsPath, {
        ts: nowIso(),
        type,
        data: clip(data),
      });
    },
    error: (type: string, error: unknown, data?: unknown) => {
      append(errorsPath, {
        ts: nowIso(),
        type,
        error: normalizeError(error),
        data: clip(data),
      });
    },
  };
}
