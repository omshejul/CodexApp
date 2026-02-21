export interface RenderedTurn {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  streaming?: boolean;
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

export function toRenderedTurns(turns: unknown[]): RenderedTurn[] {
  return turns
    .map((turn, index) => {
      const text = flattenText(turn).trim();
      if (!text) {
        return null;
      }
      return {
        id: `turn-${index}`,
        role: detectRole(turn),
        text,
      } as RenderedTurn;
    })
    .filter((turn): turn is RenderedTurn => turn !== null);
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
