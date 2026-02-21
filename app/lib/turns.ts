export interface RenderedTurn {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  images?: string[];
  streaming?: boolean;
  createdAtMs?: number;
  turnId?: string;
  kind?: "message" | "changeSummary" | "activity";
  summary?: {
    filesChanged: number;
    files: Array<{
      path: string;
      additions: number;
      deletions: number;
      snippets?: string[];
      diff?: string;
    }>;
  };
  activity?: {
    title: string;
    detail?: string;
  };
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/(?:\n[ \t]*){3,}/g, "\n\n").trim();
}

function uniqueNonEmpty(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function extractImageUri(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const directKeys = ["url", "imageUrl", "image_url", "uri", "src", "path"] as const;
  for (const key of directKeys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  const nestedKeys = ["image", "image_url", "source"] as const;
  for (const key of nestedKeys) {
    const nested = extractImageUri(record[key]);
    if (nested) {
      return nested;
    }
  }

  return null;
}

function extractImageUris(content: unknown[]): string[] {
  const urls: string[] = [];

  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }
    const record = part as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";
    const looksImageType =
      type === "image" ||
      type === "localImage" ||
      type === "input_image" ||
      type === "output_image" ||
      type === "image_url";
    const uri = extractImageUri(record);

    if (looksImageType && uri) {
      urls.push(uri);
      continue;
    }

    if (uri && (record.image !== undefined || record.image_url !== undefined || record.url !== undefined)) {
      urls.push(uri);
    }
  }

  return uniqueNonEmpty(urls);
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const direct = Number(value);
    if (Number.isFinite(direct)) {
      return direct;
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function extractItemTimestampMs(item: Record<string, unknown>): number | null {
  const directKeys: Array<keyof typeof item> = [
    "createdAt",
    "created_at",
    "timestamp",
    "time",
    "ts",
    "startedAt",
    "updatedAt",
  ];

  for (const key of directKeys) {
    const parsed = parseTimestampMs(item[key]);
    if (parsed !== null) {
      return parsed;
    }
  }

  const timing = item.timing;
  if (timing && typeof timing === "object") {
    const timingRecord = timing as Record<string, unknown>;
    const nested = parseTimestampMs(timingRecord.startedAt) ?? parseTimestampMs(timingRecord.createdAt);
    if (nested !== null) {
      return nested;
    }
  }

  return null;
}

function renderPriorityForItemType(type: unknown): number {
  if (type === "userMessage") {
    return 0;
  }
  if (type === "agentMessage") {
    return 2;
  }
  // commandExecution/fileChange/webSearch/contextCompaction and other system items.
  return 1;
}

function flattenText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => flattenText(entry)).filter(Boolean).join("\n");
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as Record<string, unknown>;

  if (typeof record.text === "string") {
    return record.text;
  }

  if (typeof record.delta === "string") {
    return record.delta;
  }

  if (typeof record.content === "string") {
    return record.content;
  }

  if (Array.isArray(record.content)) {
    return record.content
      .map((entry) => {
        if (entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).text === "string") {
          return (entry as Record<string, string>).text;
        }
        return flattenText(entry);
      })
      .filter(Boolean)
      .join("\n");
  }

  const nested = Object.values(record)
    .map((entry) => flattenText(entry))
    .filter(Boolean);

  return nested.join("\n");
}

function detectRole(turn: unknown): "user" | "assistant" | "system" {
  if (!turn || typeof turn !== "object") {
    return "assistant";
  }

  const record = turn as Record<string, unknown>;
  const role = record.role ?? record.author ?? record.kind;

  if (role === "user") {
    return "user";
  }

  if (role === "assistant" || role === "agent") {
    return "assistant";
  }

  return "system";
}

function parseInlineChangeSummary(text: string): RenderedTurn["summary"] | null {
  const normalized = normalizeText(text);
  if (!normalized) {
    return null;
  }

  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length < 2) {
    return null;
  }

  const headerMatch = lines[0].match(/^(\d+)\s+file(?:s)?\s+changed$/i);
  if (!headerMatch) {
    return null;
  }

  const files: Array<{ path: string; additions: number; deletions: number }> = [];

  for (const line of lines.slice(1)) {
    const match = line.match(/^(?:[-*]\s+)?`?([^`]+?)`?\s+\+(\d+)\s+\-(\d+)$/);
    if (!match) {
      return null;
    }
    files.push({
      path: match[1].trim(),
      additions: Number(match[2]),
      deletions: Number(match[3]),
    });
  }

  if (files.length === 0) {
    return null;
  }

  const filesChanged = Number(headerMatch[1]);
  return {
    filesChanged: Number.isFinite(filesChanged) ? filesChanged : files.length,
    files,
  };
}

function statFromUnifiedDiff(diff: string): { additions: number; deletions: number } {
  const lines = diff.split("\n");
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.startsWith("+++")) {
      continue;
    }
    if (line.startsWith("---")) {
      continue;
    }
    if (line.startsWith("+")) {
      additions += 1;
      continue;
    }
    if (line.startsWith("-")) {
      deletions += 1;
    }
  }
  return { additions, deletions };
}

function snippetFromUnifiedDiff(diff: string): string[] {
  return diff
    .split("\n")
    .filter((line) => line.length > 0)
    .slice(0, 400);
}

function toCommandActivity(record: Record<string, unknown>, id: string, createdAtMs?: number | null): RenderedTurn {
  const actions = Array.isArray(record.commandActions) ? (record.commandActions as Array<Record<string, unknown>>) : [];
  const readAction = actions.find((action) => action?.type === "read" && typeof action.path === "string");
  if (readAction && typeof readAction.path === "string") {
    return {
      id,
      role: "system",
      text: "",
      createdAtMs: createdAtMs ?? undefined,
      kind: "activity",
      activity: {
        title: `Read ${readAction.path}`,
      },
    };
  }

  const listAction = actions.find((action) => action?.type === "listFiles");
  if (listAction) {
    const path = typeof listAction.path === "string" ? listAction.path : undefined;
    return {
      id,
      role: "system",
      text: "",
      createdAtMs: createdAtMs ?? undefined,
      kind: "activity",
      activity: {
        title: path ? `Explored files in ${path}` : "Explored files",
      },
    };
  }

  const command = typeof record.command === "string" ? normalizeText(record.command) : "";
  return {
    id,
    role: "system",
    text: "",
    createdAtMs: createdAtMs ?? undefined,
    kind: "activity",
    activity: {
      title: "Ran command",
      detail: command || undefined,
    },
  };
}

function toFileChangeSummary(record: Record<string, unknown>, id: string, createdAtMs?: number | null): RenderedTurn | null {
  const changes = Array.isArray(record.changes) ? (record.changes as Array<Record<string, unknown>>) : [];
  if (!changes.length) {
    return null;
  }

  const files = changes
    .map((change) => {
      const path = typeof change.path === "string" ? change.path : null;
      const diff = typeof change.diff === "string" ? change.diff : "";
      if (!path) {
        return null;
      }
      const stat = statFromUnifiedDiff(diff);
      const snippets = snippetFromUnifiedDiff(diff);
      return {
        path,
        additions: stat.additions,
        deletions: stat.deletions,
        snippets,
        diff,
      };
    })
    .filter((entry): entry is { path: string; additions: number; deletions: number; snippets: string[]; diff: string } => entry !== null);

  if (!files.length) {
    return null;
  }

  return {
    id,
    role: "system",
    text: "",
    createdAtMs: createdAtMs ?? undefined,
    kind: "changeSummary",
    summary: {
      filesChanged: files.length,
      files,
    },
  };
}

function fromThreadItem(item: Record<string, unknown>, id: string, createdAtMs?: number | null): RenderedTurn | null {
  const type = item.type;

  if (type === "commandExecution") {
    return toCommandActivity(item, id, createdAtMs);
  }

  if (type === "fileChange") {
    return toFileChangeSummary(item, id, createdAtMs);
  }

  if (type === "contextCompaction") {
    return {
      id,
      role: "system",
      text: "",
      createdAtMs: createdAtMs ?? undefined,
      kind: "activity",
      activity: {
        title: "Context automatically compacted",
      },
    };
  }

  return null;
}

export function toRenderedTurns(turns: unknown[]): RenderedTurn[] {
  const rendered: RenderedTurn[] = [];

  for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
    const turn = turns[turnIndex];
    const turnRecord = turn && typeof turn === "object" ? (turn as Record<string, unknown>) : null;
    const turnId = turnRecord && typeof turnRecord.id === "string" ? turnRecord.id : undefined;
    const items = turnRecord ? turnRecord.items : null;

    if (!Array.isArray(items)) {
      continue;
    }

    const orderedItems = items
      .map((item, index) => ({ item, index }))
      .filter((entry): entry is { item: Record<string, unknown>; index: number } => {
        return !!entry.item && typeof entry.item === "object";
      })
      .sort((a, b) => {
        const aTime = extractItemTimestampMs(a.item);
        const bTime = extractItemTimestampMs(b.item);
        if (aTime !== null && bTime !== null && aTime !== bTime) {
          return aTime - bTime;
        }

        const aPriority = renderPriorityForItemType(a.item.type);
        const bPriority = renderPriorityForItemType(b.item.type);
        if (aPriority !== bPriority) {
          return aPriority - bPriority;
        }

        return a.index - b.index;
      });

    for (let itemIndex = 0; itemIndex < orderedItems.length; itemIndex += 1) {
      const record = orderedItems[itemIndex].item;
      const type = record.type;
      const createdAtMs = extractItemTimestampMs(record);

      if (type === "userMessage") {
        const content = Array.isArray(record.content) ? record.content : [];
        const imageUris = extractImageUris(content);
        const textParts = content
          .map((part) => {
            if (!part || typeof part !== "object") {
              return "";
            }
            const obj = part as Record<string, unknown>;
            return obj.type === "text" && typeof obj.text === "string" ? obj.text : "";
          })
          .filter(Boolean);

        const text = normalizeText(textParts.join("\n"));
        if (!text && imageUris.length === 0) {
          continue;
        }

        rendered.push({
          id: typeof record.id === "string" ? record.id : `turn-${turnIndex}-item-${itemIndex}`,
          role: "user",
          text,
          images: imageUris.length > 0 ? imageUris : undefined,
          createdAtMs: createdAtMs ?? undefined,
          turnId,
        });
        continue;
      }

      if (type === "agentMessage") {
        const content = Array.isArray(record.content) ? record.content : [];
        const imageUris = extractImageUris(content);
        const textParts = content
          .map((part) => {
            if (!part || typeof part !== "object") {
              return "";
            }
            const obj = part as Record<string, unknown>;
            if (obj.type === "text" && typeof obj.text === "string") {
              return obj.text;
            }
            return "";
          })
          .filter(Boolean);
        const fallbackText = typeof record.text === "string" ? record.text : "";
        const text = normalizeText(textParts.length > 0 ? textParts.join("\n") : fallbackText);
        if (!text && imageUris.length === 0) {
          continue;
        }

        const summary = text ? parseInlineChangeSummary(text) : null;
        if (summary) {
          rendered.push({
            id: typeof record.id === "string" ? record.id : `turn-${turnIndex}-item-${itemIndex}`,
            role: "system",
            text: "",
            createdAtMs: createdAtMs ?? undefined,
            turnId,
            kind: "changeSummary",
            summary,
          });
          continue;
        }

        rendered.push({
          id: typeof record.id === "string" ? record.id : `turn-${turnIndex}-item-${itemIndex}`,
          role: "assistant",
          text,
          images: imageUris.length > 0 ? imageUris : undefined,
          createdAtMs: createdAtMs ?? undefined,
          turnId,
          kind: "message",
        });
      }

      const derived = fromThreadItem(
        record,
        typeof record.id === "string" ? record.id : `turn-${turnIndex}-item-${itemIndex}`,
        createdAtMs
      );
      if (derived) {
        derived.turnId = turnId;
        rendered.push(derived);
      }
    }
  }

  return rendered;
}

export function extractDeltaText(params: unknown): string {
  if (!params || typeof params !== "object") {
    return "";
  }

  const record = params as Record<string, unknown>;
  const direct = record.delta ?? record.text;
  if (typeof direct === "string") {
    return direct;
  }

  if (record.message && typeof record.message === "object") {
    return extractDeltaText(record.message);
  }

  if (record.item && typeof record.item === "object") {
    return extractDeltaText(record.item);
  }

  return "";
}
