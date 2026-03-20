import { ApiHttpError, type QueuedThreadMessage } from "@/lib/api";
import { extractDeltaText, type RenderedTurn } from "@/lib/turns";
import {
  MAX_TRANSIENT_CHANGE_SUMMARY_THREADS,
  transientChangeSummariesByThreadKey,
} from "@/components/thread/screen/cache";
import {
  INTERACTIVE_REQUEST_USER_INPUT_METHOD,
  type CodexSseEvent,
  type LiveStreamState,
  type MentionToken,
  type PendingRequestUserInput,
  type RequestUserInputOption,
  type RequestUserInputQuestion,
} from "@/components/thread/screen/types";

export function getThreadPreferenceKey(threadId: string, gatewayId?: string | null): string {
  return `${gatewayId ?? "active"}:${threadId}`;
}

export function parseSsePayload(raw: string): CodexSseEvent | null {
  try {
    const parsed = JSON.parse(raw) as CodexSseEvent;
    if (!parsed || typeof parsed !== "object" || typeof parsed.method !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function extractReasoningText(params: unknown): string {
  const getString = (value: unknown): string => (typeof value === "string" && value.length > 0 ? value : "");

  const scan = (value: unknown): string => {
    if (!value || typeof value !== "object") {
      return "";
    }

    const record = value as Record<string, unknown>;

    const direct =
      getString(record.delta) ||
      getString(record.text) ||
      getString(record.summaryText) ||
      getString(record.summary_text);
    if (direct) {
      return direct;
    }

    const summaryPart = record.summaryPart;
    if (summaryPart && typeof summaryPart === "object") {
      const part = summaryPart as Record<string, unknown>;
      const partText = getString(part.delta) || getString(part.text);
      if (partText) {
        return partText;
      }
    }

    const summary = record.summary;
    if (Array.isArray(summary)) {
      const summaryText = summary
        .map((part) => {
          if (!part || typeof part !== "object") {
            return "";
          }
          const summaryRecord = part as Record<string, unknown>;
          return getString(summaryRecord.delta) || getString(summaryRecord.text);
        })
        .filter((part) => part.length > 0)
        .join("");
      if (summaryText) {
        return summaryText;
      }
    }

    if (record.item && typeof record.item === "object") {
      const nested = scan(record.item);
      if (nested) {
        return nested;
      }
    }

    if (record.message && typeof record.message === "object") {
      const nested = scan(record.message);
      if (nested) {
        return nested;
      }
    }

    return "";
  };

  return scan(params);
}

export function turnsSignature(items: RenderedTurn[]): string {
  return items
    .map((item) => `${item.id}:${item.role}:${item.kind ?? "message"}:${item.text.length}:${item.images?.length ?? 0}`)
    .join("|");
}

export function createEmptyLiveStreamState(): LiveStreamState {
  return {
    assistant: "",
    terminalOutput: "",
    terminalOutputComplete: false,
    reasoning: "",
    plan: "",
    fileChanges: "",
    toolProgress: "",
  };
}

export function hasLiveStreamContent(stream: LiveStreamState): boolean {
  return (
    stream.assistant.trim().length > 0 ||
    stream.terminalOutput.trim().length > 0 ||
    stream.reasoning.trim().length > 0 ||
    stream.plan.trim().length > 0 ||
    stream.fileChanges.trim().length > 0 ||
    stream.toolProgress.trim().length > 0
  );
}

export function sameLiveStreamState(left: LiveStreamState, right: LiveStreamState): boolean {
  return (
    left.assistant === right.assistant &&
    left.terminalOutput === right.terminalOutput &&
    left.terminalOutputComplete === right.terminalOutputComplete &&
    left.reasoning === right.reasoning &&
    left.plan === right.plan &&
    left.fileChanges === right.fileChanges &&
    left.toolProgress === right.toolProgress
  );
}

export function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string") {
      const normalized = value.trim();
      if (normalized.length > 0) {
        return normalized;
      }
    }
  }
  return null;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function toQueuedThreadMessageRequest(value: unknown): QueuedThreadMessage["request"] | null {
  const requestRecord = asRecord(value);
  if (!requestRecord) {
    return null;
  }

  const requestText = firstNonEmptyString(requestRecord.text);
  const requestModel = firstNonEmptyString(requestRecord.model);
  const requestReasoningEffort = firstNonEmptyString(requestRecord.reasoningEffort);
  const requestCollaborationMode = firstNonEmptyString(requestRecord.collaborationMode);
  const requestImages = Array.isArray(requestRecord.images)
    ? requestRecord.images
        .map((entry) => {
          const image = asRecord(entry);
          const imageUrl = firstNonEmptyString(image?.imageUrl);
          return imageUrl ? { imageUrl } : null;
        })
        .filter((entry): entry is { imageUrl: string } => entry !== null)
    : [];

  if (!requestText && requestImages.length === 0) {
    return null;
  }

  return {
    ...(requestText ? { text: requestText } : {}),
    ...(requestImages.length > 0 ? { images: requestImages } : {}),
    ...(requestModel ? { model: requestModel } : {}),
    ...(requestReasoningEffort &&
    (requestReasoningEffort === "none" ||
      requestReasoningEffort === "minimal" ||
      requestReasoningEffort === "low" ||
      requestReasoningEffort === "medium" ||
      requestReasoningEffort === "high" ||
      requestReasoningEffort === "xhigh")
      ? { reasoningEffort: requestReasoningEffort }
      : {}),
    ...(requestCollaborationMode &&
    (requestCollaborationMode === "default" || requestCollaborationMode === "plan")
      ? { collaborationMode: requestCollaborationMode }
      : {}),
  };
}

export function toQueuedThreadMessage(value: unknown): QueuedThreadMessage | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const id = firstNonEmptyString(record.id);
  const threadId = firstNonEmptyString(record.threadId);
  const createdAt = firstNonEmptyString(record.createdAt);
  const request = toQueuedThreadMessageRequest(record.request);
  if (!id || !threadId || !createdAt || !request) {
    return null;
  }

  return {
    id,
    threadId,
    request,
    createdAt,
    createdByDeviceId: firstNonEmptyString(record.createdByDeviceId) ?? undefined,
  };
}

export function toBooleanFlag(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes";
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  return false;
}

export function normalizeRequestUserInputQuestions(value: unknown): RequestUserInputQuestion[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const questions: RequestUserInputQuestion[] = [];

  for (const [index, entry] of value.entries()) {
    const record = asRecord(entry);
    if (!record) {
      continue;
    }

    const id = firstNonEmptyString(record.id) ?? `question-${index + 1}`;
    const header = firstNonEmptyString(record.header, record.title) ?? `Question ${index + 1}`;
    const question = firstNonEmptyString(record.question, record.prompt, record.message);
    if (!question) {
      continue;
    }

    const optionsValue = Array.isArray(record.options) ? record.options : null;
    const options: RequestUserInputOption[] =
      optionsValue?.flatMap((option) => {
        const optionRecord = asRecord(option);
        if (!optionRecord) {
          return [];
        }
        const label = firstNonEmptyString(optionRecord.label, optionRecord.value);
        if (!label) {
          return [];
        }
        const description = firstNonEmptyString(optionRecord.description) ?? "";
        return [{ label, description }];
      }) ?? [];

    questions.push({
      id,
      header,
      question,
      isOther: toBooleanFlag(record.isOther ?? record.is_other),
      isSecret: toBooleanFlag(record.isSecret ?? record.is_secret),
      options: options.length > 0 ? options : null,
    });
  }

  return questions;
}

export function toPendingRequestUserInput(value: unknown): PendingRequestUserInput | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const id = firstNonEmptyString(record.id);
  if (!id) {
    return null;
  }

  const method = firstNonEmptyString(record.method)?.toLowerCase() ?? "";
  if (method !== INTERACTIVE_REQUEST_USER_INPUT_METHOD) {
    return null;
  }

  const params = asRecord(record.params) ?? {};
  const questions = normalizeRequestUserInputQuestions(params.questions);
  if (questions.length === 0) {
    return null;
  }

  const createdAtMs = parseTimestampMs(record.createdAt) ?? Date.now();
  const expiresAtMs = parseTimestampMs(record.expiresAt) ?? createdAtMs + 5 * 60 * 1000;

  return {
    id,
    threadId: firstNonEmptyString(record.threadId, params.threadId, params.thread_id),
    turnId: firstNonEmptyString(record.turnId, params.turnId, params.turn_id),
    createdAtMs,
    expiresAtMs,
    questions,
  };
}

export function toPendingRequestUserInputList(value: unknown[]): PendingRequestUserInput[] {
  const byId = new Map<string, PendingRequestUserInput>();

  for (const entry of value) {
    const parsed = toPendingRequestUserInput(entry);
    if (!parsed) {
      continue;
    }
    byId.set(parsed.id, parsed);
  }

  return Array.from(byId.values()).sort((left, right) => {
    if (left.createdAtMs !== right.createdAtMs) {
      return left.createdAtMs - right.createdAtMs;
    }
    return left.id.localeCompare(right.id);
  });
}

export function upsertPendingRequestUserInput(
  existing: PendingRequestUserInput[],
  candidate: PendingRequestUserInput
): PendingRequestUserInput[] {
  const next = existing.filter((request) => request.id !== candidate.id);
  next.push(candidate);
  next.sort((left, right) => {
    if (left.createdAtMs !== right.createdAtMs) {
      return left.createdAtMs - right.createdAtMs;
    }
    return left.id.localeCompare(right.id);
  });
  return next;
}

export function queuedMessageCreatedAtMs(message: QueuedThreadMessage): number {
  const parsed = Date.parse(message.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function sortQueuedMessages(messages: QueuedThreadMessage[]): QueuedThreadMessage[] {
  return [...messages].sort((left, right) => {
    const leftMs = queuedMessageCreatedAtMs(left);
    const rightMs = queuedMessageCreatedAtMs(right);
    if (leftMs !== rightMs) {
      return leftMs - rightMs;
    }
    return left.id.localeCompare(right.id);
  });
}

export function upsertQueuedMessage(existing: QueuedThreadMessage[], candidate: QueuedThreadMessage): QueuedThreadMessage[] {
  const next = existing.filter((message) => message.id !== candidate.id);
  next.push(candidate);
  return sortQueuedMessages(next);
}

export function queuedMessageSummary(request: QueuedThreadMessage["request"]): { text: string; imageCount: number } {
  const text = typeof request.text === "string" ? request.text.trim() : "";
  const imageCount = Array.isArray(request.images)
    ? request.images.filter((image) => typeof image.imageUrl === "string" && image.imageUrl.trim().length > 0).length
    : 0;
  return { text, imageCount };
}

export function isMissingQueueRouteError(error: unknown): boolean {
  if (!(error instanceof ApiHttpError) || error.status !== 404) {
    return false;
  }
  const body = error.body.toLowerCase();
  return body.includes("/messages/queue") && body.includes("not found");
}

export function extractInteractiveLifecycleRequestId(params: unknown): string | null {
  const record = asRecord(params);
  if (!record) {
    return null;
  }
  const nestedRequest = asRecord(record.request);
  return firstNonEmptyString(record.id, nestedRequest?.id);
}

export function extractTurnIdFromUnknown(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = extractTurnIdFromUnknown(entry);
      if (found) {
        return found;
      }
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  const direct = firstNonEmptyString(record.turnId, record.turn_id, record.turnID);
  if (direct) {
    return direct;
  }
  const nestedTurn = asRecord(record.turn);
  const nestedId = firstNonEmptyString(nestedTurn?.id);
  if (nestedId) {
    return nestedId;
  }
  for (const nested of Object.values(record)) {
    const found = extractTurnIdFromUnknown(nested);
    if (found) {
      return found;
    }
  }
  return null;
}

export function uniqueAnswerValues(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));
}

export function isLikelyWebSearchToolName(value: string): boolean {
  const lower = value.trim().toLowerCase();
  if (!lower) {
    return false;
  }
  if (
    lower.includes("fuzzyfilesearch") ||
    lower.includes("fuzzy_file_search") ||
    lower.includes("file_search") ||
    lower.includes("filesearch")
  ) {
    return false;
  }
  return (
    lower.includes("web_search") ||
    lower.includes("websearch") ||
    lower.includes("search_query") ||
    lower.includes("internet_search")
  );
}

export function extractWebSearchQueries(value: unknown): string[] {
  const collected: string[] = [];
  const seenObjects = new Set<object>();
  const QUERY_KEY_PATTERN = /(query|search|term|keyword|prompt|input)/i;

  const push = (candidate: unknown) => {
    if (typeof candidate !== "string") {
      return;
    }
    const normalized = candidate.replace(/[ \t]+/g, " ").trim().replace(/^["'`]|["'`]$/g, "");
    if (normalized.length < 2) {
      return;
    }
    if (normalized.length > 240) {
      return;
    }
    if (normalized.startsWith("{") || normalized.startsWith("[") || normalized.startsWith("http://") || normalized.startsWith("https://")) {
      return;
    }
    collected.push(normalized);
  };

  const parseFromUrl = (candidate: unknown) => {
    if (typeof candidate !== "string") {
      return;
    }
    if (!(candidate.startsWith("http://") || candidate.startsWith("https://"))) {
      return;
    }
    try {
      const url = new URL(candidate);
      push(url.searchParams.get("q"));
      push(url.searchParams.get("query"));
      push(url.searchParams.get("search_query"));
    } catch {
      // Ignore invalid URLs.
    }
  };

  const visit = (node: unknown, depth = 0) => {
    if (!node || depth > 7) {
      return;
    }

    if (Array.isArray(node)) {
      for (const entry of node) {
        visit(entry, depth + 1);
      }
      return;
    }

    if (typeof node !== "object") {
      return;
    }

    if (seenObjects.has(node)) {
      return;
    }
    seenObjects.add(node);

    const record = node as Record<string, unknown>;

    push(record.query);
    push(record.q);
    push(record.searchQuery);
    push(record.search_query);
    push(record.searchTerm);
    push(record.search_term);
    push(record.keyword);
    push(record.keywords);
    push(record.prompt);
    push(record.input);
    parseFromUrl(record.url);
    parseFromUrl(record.uri);
    parseFromUrl(record.link);

    for (const [key, entry] of Object.entries(record)) {
      if (typeof entry === "string" && QUERY_KEY_PATTERN.test(key)) {
        push(entry);
      }
    }

    const queries = record.queries;
    if (Array.isArray(queries)) {
      for (const entry of queries) {
        if (typeof entry === "string") {
          push(entry);
          continue;
        }
        if (entry && typeof entry === "object") {
          const queryEntry = entry as Record<string, unknown>;
          push(queryEntry.query);
          push(queryEntry.q);
          push(queryEntry.searchQuery);
          push(queryEntry.search_query);
          push(queryEntry.searchTerm);
          push(queryEntry.search_term);
          push(queryEntry.keyword);
          push(queryEntry.keywords);
          push(queryEntry.prompt);
          push(queryEntry.input);
          push(queryEntry.text);
          parseFromUrl(queryEntry.url);
          parseFromUrl(queryEntry.uri);
          parseFromUrl(queryEntry.link);
        }
      }
    }

    const parseNestedJson = (raw: unknown) => {
      if (typeof raw !== "string") {
        return;
      }
      try {
        const parsedArgs = JSON.parse(raw) as unknown;
        visit(parsedArgs, depth + 1);
      } catch {
        // Ignore non-JSON argument payloads.
      }
    };

    parseNestedJson(record.arguments);
    parseNestedJson(record.args);
    parseNestedJson(record.input);
    parseNestedJson(record.payload);
    parseNestedJson(record.data);

    for (const entry of Object.values(record)) {
      parseFromUrl(entry);
    }

    for (const nested of Object.values(record)) {
      if (nested && typeof nested === "object") {
        visit(nested, depth + 1);
      }
    }
  };

  visit(value);
  return Array.from(new Set(collected));
}

export function toWebSearchActivity(queries: string[]): { title: string; detail?: string } {
  if (!queries.length) {
    return { title: "Web search" };
  }

  if (queries.length === 1) {
    return {
      title: "Web search",
      detail: queries[0],
    };
  }

  return {
    title: `Web search (${queries.length})`,
    detail: queries.map((query) => `- ${query}`).join("\n"),
  };
}

export function normalizePathForChangeKey(rawPath: string): string {
  const normalizedSlashes = rawPath.replace(/\\/g, "/").trim().replace(/^[ab]\//, "");
  if (!normalizedSlashes.startsWith("/")) {
    return normalizedSlashes;
  }

  const markers = ["/app/", "/gateway/", "/shared/", "/mac/", "/docs/"];
  for (const marker of markers) {
    const markerIndex = normalizedSlashes.indexOf(marker);
    if (markerIndex >= 0) {
      return normalizedSlashes.slice(markerIndex + 1);
    }
  }

  return normalizedSlashes
    .split("/")
    .filter((part) => part.length > 0)
    .slice(-6)
    .join("/");
}

export function changeSummarySignature(summary: NonNullable<RenderedTurn["summary"]>, turnAnchor = ""): string {
  const files = summary.files
    .map((file) => `${normalizePathForChangeKey(file.path)}:${file.additions}:${file.deletions}`)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .join(";");
  return `change:${turnAnchor}:${files}`;
}

export function changeSummaryMergeSignature(summary: NonNullable<RenderedTurn["summary"]>, turnAnchor = ""): string {
  const normalizedTurnAnchor = turnAnchor.trim();
  if (normalizedTurnAnchor.length > 0) {
    return `change-turn:${normalizedTurnAnchor}`;
  }
  return changeSummarySignature(summary, normalizedTurnAnchor);
}

export function turnMergeSignature(item: RenderedTurn): string {
  const turnAnchor = item.turnId ?? "";
  if (item.kind === "changeSummary" && item.summary) {
    return changeSummaryMergeSignature(item.summary, turnAnchor);
  }
  return turnContentSignature(item);
}

export function turnContentSignature(item: RenderedTurn): string {
  const turnAnchor = item.turnId ?? "";
  if (item.kind === "changeSummary" && item.summary) {
    return changeSummarySignature(item.summary, turnAnchor);
  }
  if (item.kind === "activity" && item.activity) {
    return `activity:${turnAnchor}:${item.activity.title}:${item.activity.detail ?? ""}`;
  }
  return `msg:${turnAnchor}:${item.role}:${item.text}:${(item.images ?? []).join(",")}`;
}

export function mergeChangeSummaryFiles(
  left: NonNullable<RenderedTurn["summary"]>["files"],
  right: NonNullable<RenderedTurn["summary"]>["files"]
): NonNullable<RenderedTurn["summary"]>["files"] {
  const byKey = new Map<
    string,
    {
      path: string;
      additions: number;
      deletions: number;
      snippets?: string[];
      diff?: string;
    }
  >();

  const push = (file: {
    path: string;
    additions: number;
    deletions: number;
    snippets?: string[];
    diff?: string;
  }) => {
    const normalizedPath = normalizePathForChangeKey(file.path);
    const key = `${normalizedPath}:${file.additions}:${file.deletions}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        ...file,
        path: normalizedPath,
      });
      return;
    }

    if ((!existing.diff || existing.diff.length === 0) && typeof file.diff === "string" && file.diff.length > 0) {
      existing.diff = file.diff;
    }

    const existingSnippets = Array.isArray(existing.snippets) ? existing.snippets : [];
    const incomingSnippets = Array.isArray(file.snippets) ? file.snippets : [];
    if (existingSnippets.length === 0 && incomingSnippets.length > 0) {
      existing.snippets = incomingSnippets;
    }
  };

  for (const file of left) {
    push(file);
  }
  for (const file of right) {
    push(file);
  }

  return Array.from(byKey.values());
}

export function mergeChangeSummaryTurns(existing: RenderedTurn, candidate: RenderedTurn): RenderedTurn {
  if (existing.kind !== "changeSummary" || !existing.summary || candidate.kind !== "changeSummary" || !candidate.summary) {
    return candidate;
  }

  const files = mergeChangeSummaryFiles(existing.summary.files, candidate.summary.files);
  return {
    ...existing,
    ...candidate,
    kind: "changeSummary",
    summary: {
      displayKind:
        existing.summary.displayKind === "change" || candidate.summary.displayKind === "change"
          ? "change"
          : existing.summary.displayKind ?? candidate.summary.displayKind,
      filesChanged: files.length,
      files,
    },
  };
}

export function mergeTurnsBySignature(turns: RenderedTurn[]): RenderedTurn[] {
  const merged: RenderedTurn[] = [];
  const indexBySignature = new Map<string, number>();

  for (const turn of turns) {
    const signature = turnMergeSignature(turn);
    const existingIndex = indexBySignature.get(signature);
    if (typeof existingIndex !== "number") {
      indexBySignature.set(signature, merged.length);
      merged.push(turn);
      continue;
    }

    const existing = merged[existingIndex];
    merged[existingIndex] = mergeChangeSummaryTurns(existing, turn);
  }

  return merged;
}

export function cacheTransientChangeSummaryTurn(threadKey: string, turn: RenderedTurn) {
  if (turn.kind !== "changeSummary" || !turn.summary) {
    return;
  }

  const existing = transientChangeSummariesByThreadKey.get(threadKey) ?? [];
  const merged = mergeTurnsBySignature([...existing, turn]).slice(-200);
  transientChangeSummariesByThreadKey.set(threadKey, merged);

  if (transientChangeSummariesByThreadKey.size <= MAX_TRANSIENT_CHANGE_SUMMARY_THREADS) {
    return;
  }

  const oldestKey = transientChangeSummariesByThreadKey.keys().next().value;
  if (typeof oldestKey === "string") {
    transientChangeSummariesByThreadKey.delete(oldestKey);
  }
}

export function mergeWithTransientChangeSummaryCache(turns: RenderedTurn[], threadKey: string | null): RenderedTurn[] {
  if (!threadKey) {
    return turns;
  }
  const cached = transientChangeSummariesByThreadKey.get(threadKey);
  if (!cached || cached.length === 0) {
    return turns;
  }
  return mergeTurnsBySignature([...turns, ...cached]);
}

export function parseFilesFromUnifiedDiff(diffText: string): Array<{
  path: string;
  additions: number;
  deletions: number;
  snippets: string[];
  diff: string;
}> {
  const lines = diffText.split("\n");
  const perFile = new Map<
    string,
    {
      additions: number;
      deletions: number;
      snippets: string[];
      lines: string[];
    }
  >();
  let currentPath: string | null = null;

  for (const line of lines) {
    const header = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (header) {
      currentPath = (header[2] || header[1]).trim();
      if (!perFile.has(currentPath)) {
        perFile.set(currentPath, { additions: 0, deletions: 0, snippets: [], lines: [] });
      }
    }

    if (!currentPath) {
      const plusHeader = line.match(/^\+\+\+\s+(.+)$/);
      if (plusHeader && plusHeader[1] && plusHeader[1] !== "/dev/null") {
        const rawPath = plusHeader[1].trim();
        const normalizedPath = rawPath.replace(/^[ab]\//, "");
        if (normalizedPath.length > 0) {
          currentPath = normalizedPath;
          if (!perFile.has(currentPath)) {
            perFile.set(currentPath, { additions: 0, deletions: 0, snippets: [], lines: [] });
          }
        }
      }
    }

    if (currentPath) {
      const stat = perFile.get(currentPath);
      if (stat) {
        stat.lines.push(line);
        if (!line.startsWith("+++ ") && !line.startsWith("--- ")) {
          if (line.startsWith("+")) {
            stat.additions += 1;
            if (stat.snippets.length < 10) {
              stat.snippets.push(line);
            }
          } else if (line.startsWith("-")) {
            stat.deletions += 1;
            if (stat.snippets.length < 10) {
              stat.snippets.push(line);
            }
          }
        }
      }
    }
  }

  return Array.from(perFile.entries()).map(([path, stat]) => ({
    path,
    additions: stat.additions,
    deletions: stat.deletions,
    snippets: stat.snippets,
    diff: stat.lines.join("\n"),
  }));
}

export function isLikelyUnifiedDiff(value: string): boolean {
  const text = value.trim();
  if (text.length === 0) {
    return false;
  }
  if (text.includes("diff --git")) {
    return true;
  }
  return text.includes("@@") && text.includes("--- ") && text.includes("+++ ");
}

export function extractChangeSummaryFromEvent(method: string, params: unknown): RenderedTurn["summary"] | null {
  const lower = method.toLowerCase();
  const isFileChangeEvent =
    lower.includes("item/filechange") ||
    lower.includes("filechange") ||
    lower.includes("file_change") ||
    lower.includes("turn/diff") ||
    lower.includes("diff/updated");

  const files: Array<{ path: string; additions: number; deletions: number; snippets?: string[]; diff?: string }> = [];
  const seen = new Set<string>();

  const walk = (value: unknown) => {
    if (!value) {
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        walk(entry);
      }
      return;
    }
    if (typeof value !== "object") {
      return;
    }

    const record = value as Record<string, unknown>;
    const pathValue = record.path ?? record.filePath ?? record.file ?? record.filename;
    const diffValue =
      typeof record.diff === "string"
        ? record.diff
        : typeof record.patch === "string"
        ? record.patch
        : typeof record.unifiedDiff === "string"
        ? record.unifiedDiff
        : typeof record.unified_diff === "string"
        ? record.unified_diff
        : null;

    if (typeof pathValue === "string" && pathValue.trim().length > 0 && typeof diffValue === "string" && diffValue.trim().length > 0) {
      const additions = diffValue
        .split("\n")
        .filter((line) => line.startsWith("+") && !line.startsWith("+++ "))
        .length;
      const deletions = diffValue
        .split("\n")
        .filter((line) => line.startsWith("-") && !line.startsWith("--- "))
        .length;
      const key = `${pathValue}:${additions}:${deletions}:${diffValue.length}`;
      if (!seen.has(key)) {
        seen.add(key);
        files.push({
          path: pathValue.trim(),
          additions,
          deletions,
          diff: diffValue,
        });
      }
    }

    const additionsValue = record.additions ?? record.added ?? record.linesAdded;
    const deletionsValue = record.deletions ?? record.removed ?? record.linesRemoved;
    const additions =
      typeof additionsValue === "number"
        ? additionsValue
        : typeof additionsValue === "string"
        ? Number.parseInt(additionsValue, 10)
        : NaN;
    const deletions =
      typeof deletionsValue === "number"
        ? deletionsValue
        : typeof deletionsValue === "string"
        ? Number.parseInt(deletionsValue, 10)
        : NaN;

    if (
      typeof pathValue === "string" &&
      Number.isFinite(additions) &&
      Number.isFinite(deletions)
    ) {
      const key = `${pathValue}:${additions}:${deletions}`;
      if (!seen.has(key)) {
        seen.add(key);
        files.push({
          path: pathValue,
          additions,
          deletions,
        });
      }
    }

    for (const valueEntry of Object.values(record)) {
      if (typeof valueEntry === "string" && isLikelyUnifiedDiff(valueEntry)) {
        const parsedFiles = parseFilesFromUnifiedDiff(valueEntry);
        if (!parsedFiles.length && typeof pathValue === "string" && pathValue.trim().length > 0) {
          const additions = valueEntry
            .split("\n")
            .filter((line) => line.startsWith("+") && !line.startsWith("+++ "))
            .length;
          const deletions = valueEntry
            .split("\n")
            .filter((line) => line.startsWith("-") && !line.startsWith("--- "))
            .length;
          const key = `${pathValue}:${additions}:${deletions}:${valueEntry.length}`;
          if (!seen.has(key)) {
            seen.add(key);
            files.push({
              path: pathValue.trim(),
              additions,
              deletions,
              diff: valueEntry,
            });
          }
          continue;
        }
        for (const parsed of parsedFiles) {
          const key = `${parsed.path}:${parsed.additions}:${parsed.deletions}:${parsed.diff.length}`;
          if (!seen.has(key)) {
            seen.add(key);
            files.push(parsed);
          }
        }
      }
    }

    for (const nested of Object.values(record)) {
      walk(nested);
    }
  };

  walk(params);

  if (!files.length && (lower.includes("diff") || lower.includes("filechange") || lower.includes("file_change"))) {
    return null;
  }

  if (!files.length) {
    return null;
  }

  return {
    displayKind: isFileChangeEvent ? "change" : "preview",
    filesChanged: files.length,
    files,
  };
}

export function extractActivityFromEvent(method: string, params: unknown): RenderedTurn | null {
  const lower = method.toLowerCase();
  const nonce = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  if (lower === "thread/compacted") {
    return {
      id: `activity-compact-${nonce}`,
      role: "system",
      text: "",
      kind: "activity",
      activity: {
        title: "Context automatically compacted",
      },
    };
  }

  if (lower === "fuzzyfilesearch/sessionupdated") {
    const record = params && typeof params === "object" ? (params as Record<string, unknown>) : null;
    const files = record && Array.isArray(record.files) ? record.files : [];
    return {
      id: `activity-search-${nonce}`,
      role: "system",
      text: "",
      kind: "activity",
      activity: {
        title: `Explored ${files.length} file${files.length === 1 ? "" : "s"}`,
      },
    };
  }

  if (lower === "rawresponseitem/completed") {
    if (!params || typeof params !== "object") {
      return null;
    }
    const record = params as Record<string, unknown>;
    const item = record.item;
    if (!item || typeof item !== "object") {
      return null;
    }
    const responseItem = item as Record<string, unknown>;
    const type = typeof responseItem.type === "string" ? responseItem.type : "";
    const typeLower = type.toLowerCase();
    const responseToolName = firstNonEmptyString(
      responseItem.name,
      responseItem.toolName,
      responseItem.tool_name,
      responseItem.serverToolName,
      responseItem.server_tool_name,
      responseItem.callName,
      responseItem.call_name
    );
    const responseId = `raw-${nonce}`;

    if (
      typeLower === "web_search_call" ||
      isLikelyWebSearchToolName(typeLower) ||
      isLikelyWebSearchToolName(responseToolName ?? "")
    ) {
      const queries = extractWebSearchQueries(responseItem.action ?? responseItem);
      return {
        id: responseId,
        role: "system",
        text: "",
        kind: "activity",
        activity: toWebSearchActivity(queries),
      };
    }

    if (typeLower === "local_shell_call") {
      const action = responseItem.action && typeof responseItem.action === "object" ? (responseItem.action as Record<string, unknown>) : null;
      const command = action && Array.isArray(action.command) ? action.command.filter((part) => typeof part === "string").join(" ") : "";
      return {
        id: responseId,
        role: "system",
        text: "",
        kind: "activity",
        activity: {
          title: "Ran command",
          detail: command || undefined,
        },
      };
    }

    if (typeLower === "compaction") {
      return {
        id: responseId,
        role: "system",
        text: "",
        kind: "activity",
        activity: {
          title: "Context automatically compacted",
        },
      };
    }
  }

  if (
    lower !== "item/completed" &&
    lower !== "item/started" &&
    lower !== "codex/event/item_started" &&
    lower !== "codex/event/item_completed"
  ) {
    return null;
  }

  if (!params || typeof params !== "object") {
    return null;
  }

  const record = params as Record<string, unknown>;
  const nestedMsg = record.msg && typeof record.msg === "object" ? (record.msg as Record<string, unknown>) : null;
  const item = record.item ?? nestedMsg?.item;
  if (!item || typeof item !== "object") {
    return null;
  }

  const threadItem = item as Record<string, unknown>;
  const itemType = typeof threadItem.type === "string" ? threadItem.type : "";
  const itemTypeLower = itemType.toLowerCase();
  const itemId = typeof threadItem.id === "string" ? threadItem.id : `generated-${nonce}`;

  if (itemTypeLower === "contextcompaction") {
    return {
      id: `activity-${itemId}`,
      role: "system",
      text: "",
      kind: "activity",
      activity: {
        title: "Context automatically compacted",
      },
    };
  }

  if (itemTypeLower === "commandexecution") {
    const actions = Array.isArray(threadItem.commandActions) ? (threadItem.commandActions as Array<Record<string, unknown>>) : [];
    const readAction = actions.find((action) => action?.type === "read" && typeof action.path === "string");
    if (readAction && typeof readAction.path === "string") {
      return {
        id: `activity-${itemId}`,
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
      const path = typeof listAction.path === "string" ? listAction.path : "";
      return {
        id: `activity-${itemId}`,
        role: "system",
        text: "",
        kind: "activity",
        activity: {
          title: path ? `Explored files in ${path}` : "Explored files",
        },
      };
    }

    const command = typeof threadItem.command === "string" ? threadItem.command.trim() : "";
    return {
      id: `activity-${itemId}`,
      role: "system",
      text: "",
      kind: "activity",
      activity: {
        title: "Ran command",
        detail: command || undefined,
      },
    };
  }

  if (itemTypeLower === "websearch") {
    const queries = extractWebSearchQueries(threadItem);
    return {
      id: `activity-${itemId}`,
      role: "system",
      text: "",
      kind: "activity",
      activity: toWebSearchActivity(queries),
    };
  }

  if (itemTypeLower === "mcptoolcall" || itemTypeLower === "toolcall") {
    const toolName = firstNonEmptyString(
      threadItem.name,
      threadItem.toolName,
      threadItem.tool_name,
      threadItem.serverToolName,
      threadItem.server_tool_name,
      threadItem.callName,
      threadItem.call_name
    );
    const queries = extractWebSearchQueries(threadItem);
    if (isLikelyWebSearchToolName(toolName ?? "") || queries.length > 0) {
      return {
        id: `activity-${itemId}`,
        role: "system",
        text: "",
        kind: "activity",
        activity: toWebSearchActivity(queries),
      };
    }
  }

  return null;
}

export function extractTerminalOutputTurnFromEvent(
  method: string,
  params: unknown
): (RenderedTurn & { itemId?: string }) | null {
  const lower = method.toLowerCase();
  if (!params || typeof params !== "object") {
    return null;
  }

  const record = params as Record<string, unknown>;
  const nestedMsg = record.msg && typeof record.msg === "object" ? (record.msg as Record<string, unknown>) : null;
  const item = record.item ?? nestedMsg?.item;
  const itemRecord = item && typeof item === "object" ? (item as Record<string, unknown>) : null;

  if (lower.includes("commandexecution/outputdelta")) {
    const delta = extractDeltaText(params);
    const itemId =
      firstNonEmptyString(record.itemId, record.item_id) ??
      firstNonEmptyString(itemRecord?.id);
    if (!delta || !itemId) {
      return null;
    }
    return {
      id: `terminal-${itemId}`,
      itemId,
      role: "system",
      text: "",
      kind: "activity",
      activity: {
        title: "Terminal output",
        detail: delta,
      },
    };
  }

  if (
    lower === "item/completed" ||
    lower === "codex/event/item_completed" ||
    lower === "rawresponseitem/completed"
  ) {
    if (!itemRecord) {
      return null;
    }
    const itemType = typeof itemRecord.type === "string" ? itemRecord.type.toLowerCase() : "";
    if (itemType !== "commandexecution") {
      return null;
    }
    const detail =
      firstNonEmptyString(itemRecord.aggregatedOutput, itemRecord.output, itemRecord.stdout) ??
      extractDeltaText(itemRecord);
    const itemId = firstNonEmptyString(itemRecord.id);
    if (!detail || !itemId) {
      return null;
    }
    return {
      id: `terminal-${itemId}`,
      itemId,
      role: "system",
      text: "",
      kind: "activity",
      activity: {
        title: "Terminal output",
        detail,
      },
    };
  }

  return null;
}

export function extractStreamingActivityTurnFromEvent(
  method: string,
  params: unknown
): (RenderedTurn & { itemId?: string }) | null {
  const lower = method.toLowerCase();
  const record = params && typeof params === "object" ? (params as Record<string, unknown>) : null;
  const nestedMsg = record?.msg && typeof record.msg === "object" ? (record.msg as Record<string, unknown>) : null;
  const item = record?.item ?? nestedMsg?.item;
  const itemRecord = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
  const itemId =
    firstNonEmptyString(record?.itemId, record?.item_id) ??
    firstNonEmptyString(itemRecord?.id);

  const createTurn = (title: string, detail: string | null) => {
    if (!detail) {
      return null;
    }
    return {
      id: `${title.toLowerCase().replace(/\s+/g, "-")}-${itemId ?? "turn"}`,
      itemId: itemId ?? undefined,
      role: "system" as const,
      text: "",
      kind: "activity" as const,
      activity: {
        title,
        detail,
      },
    };
  };

  if (
    lower.includes("reasoning/textdelta") ||
    lower.includes("reasoning/summarytextdelta") ||
    lower.includes("reasoning/summarypartadded")
  ) {
    return createTurn("Reasoning", extractReasoningText(params));
  }

  if (lower.includes("item/plan/delta") || lower.includes("turn/plan/updated")) {
    const detail =
      extractDeltaText(params) ||
      (params && typeof params === "object" ? JSON.stringify(params, null, 2) : "");
    return createTurn("Plan", detail);
  }

  if (lower.includes("item/filechange/outputdelta")) {
    const detail =
      extractDeltaText(params) ||
      (params && typeof params === "object" ? JSON.stringify(params, null, 2) : "");
    return createTurn("File changes", detail);
  }

  if (lower.includes("item/mcptoolcall/progress")) {
    const progressToolName = firstNonEmptyString(
      record?.toolName,
      record?.tool_name,
      record?.name,
      record?.callName,
      record?.call_name,
      itemRecord?.name,
      itemRecord?.toolName,
      itemRecord?.tool_name,
      itemRecord?.serverToolName,
      itemRecord?.server_tool_name
    );
    const progressQueries = extractWebSearchQueries(params);
    if (progressQueries.length > 0 || isLikelyWebSearchToolName(progressToolName ?? "")) {
      return null;
    }

    const detail =
      extractDeltaText(params) ||
      (params && typeof params === "object" ? JSON.stringify(params, null, 2) : "");
    return createTurn("Tool progress", detail);
  }

  return null;
}

export function mergeActivityTurns(existing: RenderedTurn, candidate: RenderedTurn): RenderedTurn {
  if (existing.kind !== "activity" || !existing.activity || candidate.kind !== "activity" || !candidate.activity) {
    return candidate;
  }
  if (existing.activity.title !== candidate.activity.title) {
    return candidate;
  }

  const mergeableTitles = new Set(["Terminal output", "Reasoning", "Plan", "File changes", "Tool progress"]);
  if (!mergeableTitles.has(existing.activity.title)) {
    return candidate;
  }

  const existingDetail = existing.activity.detail ?? "";
  const candidateDetail = candidate.activity.detail ?? "";
  if (!existingDetail) {
    return candidate;
  }
  if (!candidateDetail) {
    return existing;
  }
  if (existingDetail === candidateDetail) {
    return {
      ...existing,
      ...candidate,
      activity: {
        ...candidate.activity,
        detail: existingDetail,
      },
    };
  }
  if (candidateDetail.startsWith(existingDetail)) {
    return candidate;
  }
  if (existingDetail.startsWith(candidateDetail)) {
    return {
      ...existing,
      ...candidate,
      activity: {
        ...candidate.activity,
        detail: existingDetail,
      },
    };
  }

  return {
    ...existing,
    ...candidate,
    activity: {
      ...candidate.activity,
      detail: `${existingDetail}${candidateDetail}`,
    },
  };
}

export function toPersistedEventTurns(
  events: Array<{ id: number; method: string; params?: unknown; createdAt?: string; turnId?: string }>,
  existing: RenderedTurn[]
): RenderedTurn[] {
  const merged = [...existing];
  const seen = new Set(merged.map((item) => turnMergeSignature(item)));
  const streamingActivityIndexByKey = new Map<string, number>();
  merged.forEach((item, index) => {
    if (
      item.kind === "activity" &&
      item.activity &&
      ["Terminal output", "Reasoning", "Plan", "File changes", "Tool progress"].includes(item.activity.title)
    ) {
      const key = `${item.turnId ?? ""}:${item.activity.title}:${item.id}`;
      streamingActivityIndexByKey.set(key, index);
    }
  });
  const insertCandidate = (candidate: RenderedTurn) => {
    if (candidate.turnId) {
      let firstAssistantInTurn = -1;
      for (let index = 0; index < merged.length; index += 1) {
        const item = merged[index];
        if (item.turnId === candidate.turnId && item.role === "assistant") {
          firstAssistantInTurn = index;
          break;
        }
      }
      if (firstAssistantInTurn >= 0) {
        merged.splice(firstAssistantInTurn, 0, candidate);
        return;
      }

      let lastInTurn = -1;
      for (let index = merged.length - 1; index >= 0; index -= 1) {
        if (merged[index].turnId === candidate.turnId) {
          lastInTurn = index;
          break;
        }
      }
      if (lastInTurn >= 0) {
        merged.splice(lastInTurn + 1, 0, candidate);
        return;
      }
    }

    const candidateMs = typeof candidate.createdAtMs === "number" && Number.isFinite(candidate.createdAtMs) ? candidate.createdAtMs : null;
    if (candidateMs !== null) {
      const firstLaterIndex = merged.findIndex((item) => {
        const itemMs = typeof item.createdAtMs === "number" && Number.isFinite(item.createdAtMs) ? item.createdAtMs : null;
        return itemMs !== null && itemMs > candidateMs;
      });
      if (firstLaterIndex >= 0) {
        merged.splice(firstLaterIndex, 0, candidate);
        return;
      }

      let lastTimestampedIndex = -1;
      for (let index = merged.length - 1; index >= 0; index -= 1) {
        const itemMs = typeof merged[index].createdAtMs === "number" && Number.isFinite(merged[index].createdAtMs)
          ? merged[index].createdAtMs
          : null;
        if (itemMs !== null) {
          lastTimestampedIndex = index;
          break;
        }
      }
      if (lastTimestampedIndex >= 0) {
        merged.splice(lastTimestampedIndex + 1, 0, candidate);
        return;
      }
    }

    merged.push(candidate);
  };
  const mergeCandidate = (candidate: RenderedTurn): boolean => {
    const signature = turnMergeSignature(candidate);
    const existingIndex = merged.findIndex((item) => turnMergeSignature(item) === signature);
    if (existingIndex < 0) {
      return false;
    }

    const existingItem = merged[existingIndex];
    merged[existingIndex] =
      existingItem.kind === "changeSummary" && existingItem.summary && candidate.kind === "changeSummary" && candidate.summary
        ? mergeChangeSummaryTurns(existingItem, candidate)
        : existingItem;
    return true;
  };

  for (const event of events) {
    const createdAtMs = parseTimestampMs(event.createdAt);
    const terminalTurn = extractTerminalOutputTurnFromEvent(event.method, event.params ?? null);
    if (terminalTurn) {
      const candidate: RenderedTurn = {
        ...terminalTurn,
        id: `${terminalTurn.id}-${event.id}`,
        createdAtMs: createdAtMs ?? undefined,
        turnId: event.turnId,
      };
      const terminalKey = `${event.turnId ?? ""}:Terminal output:${terminalTurn.itemId ?? terminalTurn.id}`;
      const existingIndex = streamingActivityIndexByKey.get(terminalKey);
      if (typeof existingIndex === "number") {
        merged[existingIndex] = mergeActivityTurns(merged[existingIndex], candidate);
      } else {
        insertCandidate(candidate);
        streamingActivityIndexByKey.set(terminalKey, merged.findIndex((item) => item.id === candidate.id));
      }
      continue;
    }

    const streamingActivity = extractStreamingActivityTurnFromEvent(event.method, event.params ?? null);
    if (streamingActivity) {
      const candidate: RenderedTurn = {
        ...streamingActivity,
        id: `${streamingActivity.id}-${event.id}`,
        createdAtMs: createdAtMs ?? undefined,
        turnId: event.turnId,
      };
      const activityKey = `${event.turnId ?? ""}:${streamingActivity.activity?.title ?? ""}:${streamingActivity.itemId ?? streamingActivity.id}`;
      const existingIndex = streamingActivityIndexByKey.get(activityKey);
      if (typeof existingIndex === "number") {
        merged[existingIndex] = mergeActivityTurns(merged[existingIndex], candidate);
      } else {
        insertCandidate(candidate);
        streamingActivityIndexByKey.set(activityKey, merged.findIndex((item) => item.id === candidate.id));
      }
      continue;
    }

    const summary = extractChangeSummaryFromEvent(event.method, event.params ?? null);
    if (summary) {
      const candidate: RenderedTurn = {
        id: `persisted-change-${event.id}`,
        role: "system",
        text: "",
        createdAtMs: createdAtMs ?? undefined,
        turnId: event.turnId,
        kind: "changeSummary",
        summary,
      };
      const signature = turnMergeSignature(candidate);
      if (!seen.has(signature)) {
        seen.add(signature);
        insertCandidate(candidate);
      } else {
        mergeCandidate(candidate);
      }
      continue;
    }

    const activity = extractActivityFromEvent(event.method, event.params ?? null);
    if (activity) {
      const candidate: RenderedTurn = {
        ...activity,
        id: `persisted-activity-${event.id}`,
        createdAtMs: createdAtMs ?? undefined,
        turnId: event.turnId,
      };
      const signature = turnContentSignature(candidate);
      if (!seen.has(signature)) {
        seen.add(signature);
        insertCandidate(candidate);
      }
    }
  }

  return merged;
}

export function findActiveMentionToken(text: string, cursor: number): MentionToken | null {
  const safeCursor = Math.max(0, Math.min(cursor, text.length));
  const prefix = text.slice(0, safeCursor);
  const atIndex = prefix.lastIndexOf("@");
  if (atIndex < 0) {
    return null;
  }

  const charBefore = atIndex > 0 ? prefix[atIndex - 1] : "";
  if (charBefore && !/\s/.test(charBefore)) {
    return null;
  }

  const mentionBody = prefix.slice(atIndex + 1);
  if (/\s/.test(mentionBody)) {
    return null;
  }

  return {
    start: atIndex,
    end: safeCursor,
    query: mentionBody,
  };
}
