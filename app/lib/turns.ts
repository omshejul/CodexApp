export interface RenderedTurn {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  streaming?: boolean;
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

function toCommandActivity(record: Record<string, unknown>, id: string): RenderedTurn {
  const actions = Array.isArray(record.commandActions) ? (record.commandActions as Array<Record<string, unknown>>) : [];
  const readAction = actions.find((action) => action?.type === "read" && typeof action.path === "string");
  if (readAction && typeof readAction.path === "string") {
    return {
      id,
      role: "system",
      text: "",
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
    kind: "activity",
    activity: {
      title: "Ran command",
      detail: command || undefined,
    },
  };
}

function toFileChangeSummary(record: Record<string, unknown>, id: string): RenderedTurn | null {
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
    kind: "changeSummary",
    summary: {
      filesChanged: files.length,
      files,
    },
  };
}

function fromThreadItem(item: Record<string, unknown>, id: string): RenderedTurn | null {
  const type = item.type;

  if (type === "commandExecution") {
    return toCommandActivity(item, id);
  }

  if (type === "fileChange") {
    return toFileChangeSummary(item, id);
  }

  if (type === "contextCompaction") {
    return {
      id,
      role: "system",
      text: "",
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
    const items = turn && typeof turn === "object" ? (turn as Record<string, unknown>).items : null;

    if (!Array.isArray(items)) {
      continue;
    }

    for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
      const item = items[itemIndex];
      if (!item || typeof item !== "object") {
        continue;
      }

      const record = item as Record<string, unknown>;
      const type = record.type;

      if (type === "userMessage") {
        const content = Array.isArray(record.content) ? record.content : [];
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
        if (!text) {
          continue;
        }

        rendered.push({
          id: typeof record.id === "string" ? record.id : `turn-${turnIndex}-item-${itemIndex}`,
          role: "user",
          text,
        });
        continue;
      }

      if (type === "agentMessage") {
        const text = normalizeText(typeof record.text === "string" ? record.text : "");
        if (!text) {
          continue;
        }

        const summary = parseInlineChangeSummary(text);
        if (summary) {
          rendered.push({
            id: typeof record.id === "string" ? record.id : `turn-${turnIndex}-item-${itemIndex}`,
            role: "system",
            text: "",
            kind: "changeSummary",
            summary,
          });
          continue;
        }

        rendered.push({
          id: typeof record.id === "string" ? record.id : `turn-${turnIndex}-item-${itemIndex}`,
          role: "assistant",
          text,
          kind: "message",
        });
      }

      const derived = fromThreadItem(
        record,
        typeof record.id === "string" ? record.id : `turn-${turnIndex}-item-${itemIndex}`
      );
      if (derived) {
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
