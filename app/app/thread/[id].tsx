import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Keyboard,
  Modal,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { KeyboardAvoidingView, KeyboardStickyView } from "react-native-keyboard-controller";
import { useLocalSearchParams } from "expo-router";
import { router } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";
import * as Clipboard from "expo-clipboard";
import { AnimatePresence, MotiView } from "moti";
import { Ionicons } from "@expo/vector-icons";
import Markdown, { RenderRules } from "react-native-markdown-display";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import {
  ApiHttpError,
  ReauthRequiredError,
  clearSession,
  getGatewayOptions,
  getStreamConfig,
  getThreads,
  getThreadFiles,
  getThread,
  getThreadEvents,
  interruptThreadTurn,
  resumeThread,
  sendThreadMessage,
} from "@/lib/api";
import { formatPathForDisplay } from "@/lib/path";
import { extractDeltaText, RenderedTurn, toRenderedTurns } from "@/lib/turns";

interface CodexSseEvent {
  method: string;
  params: unknown;
}

type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

interface ModelOption {
  label: string;
  value: string;
}

interface ReasoningOption {
  label: string;
  value: ReasoningEffort;
}

interface PendingImage {
  id: string;
  uri: string;
  imageUrl: string;
}

interface ComposerSelection {
  start: number;
  end: number;
}

interface MentionToken {
  start: number;
  end: number;
  query: string;
}

const DIRECTIVE_LINE_PATTERN = /^::[a-z][a-z0-9-]*\{.*\}\s*$/i;

const DEFAULT_REASONING_OPTIONS: ReasoningOption[] = [
  { label: "Minimal", value: "minimal" },
  { label: "Low", value: "low" },
  { label: "Medium", value: "medium" },
  { label: "High", value: "high" },
];

type OpenDropdown = "model" | "reasoning" | null;
type StreamStatusTone = "ok" | "warn" | "error";

const SYSTEM_FONT = Platform.select({
  ios: "System",
  android: "sans-serif",
  default: "System",
});

const MONO_FONT = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "monospace",
});

const markdownStyles = {
  body: {
    color: "#d1dced",
    fontSize: 15,
    lineHeight: 23,
    fontFamily: SYSTEM_FONT,
  },
  heading1: {
    color: "#f0f6ff",
    fontSize: 22,
    fontWeight: "700" as const,
    marginTop: 16,
    marginBottom: 8,
    fontFamily: SYSTEM_FONT,
  },
  heading2: {
    color: "#ecf2fc",
    fontSize: 19,
    fontWeight: "600" as const,
    marginTop: 14,
    marginBottom: 6,
    fontFamily: SYSTEM_FONT,
  },
  heading3: {
    color: "#e4ecf8",
    fontSize: 16,
    fontWeight: "600" as const,
    marginTop: 10,
    marginBottom: 4,
    fontFamily: SYSTEM_FONT,
  },
  paragraph: { marginTop: 0, marginBottom: 10 },
  bullet_list: { marginTop: 0, marginBottom: 8 },
  ordered_list: { marginTop: 0, marginBottom: 8 },
  list_item: { marginBottom: 4 },
  ordered_list_content: { flex: 1, flexShrink: 1 },
  bullet_list_content: { flex: 1, flexShrink: 1 },
  code_inline: {
    backgroundColor: "rgba(240,246,255,0.08)",
    color: "#a5d6ff",
    borderRadius: 5,
    paddingHorizontal: 6,
    paddingVertical: 1.5,
    fontFamily: MONO_FONT,
    fontSize: 13.5,
  },
  code_block: {
    backgroundColor: "#0d1117",
    color: "#e6edf3",
    borderRadius: 12,
    padding: 14,
    marginTop: 6,
    marginBottom: 12,
    fontFamily: MONO_FONT,
    fontSize: 13,
    lineHeight: 20,
  },
  fence: {
    backgroundColor: "#0d1117",
    color: "#e6edf3",
    borderRadius: 12,
    padding: 14,
    marginTop: 6,
    marginBottom: 12,
    fontFamily: MONO_FONT,
    fontSize: 13,
    lineHeight: 20,
  },
  blockquote: {
    backgroundColor: "rgba(56,139,253,0.06)",
    borderLeftWidth: 3,
    borderLeftColor: "#388bfd",
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginVertical: 8,
  },
  hr: { backgroundColor: "rgba(255,255,255,0.08)", marginVertical: 16 },
  strong: { color: "#f0f6ff", fontWeight: "600" as const },
  em: { color: "#c9d8ec" },
  link: { color: "#58a6ff" },
};

const userMarkdownStyles = {
  ...markdownStyles,
  body: {
    color: "#f4f8ff",
    fontSize: 15,
    lineHeight: 23,
    fontFamily: SYSTEM_FONT,
  },
  heading1: {
    color: "#ffffff",
    fontSize: 22,
    fontWeight: "700" as const,
    marginTop: 16,
    marginBottom: 8,
    fontFamily: SYSTEM_FONT,
  },
  heading2: {
    color: "#ffffff",
    fontSize: 19,
    fontWeight: "600" as const,
    marginTop: 14,
    marginBottom: 6,
    fontFamily: SYSTEM_FONT,
  },
  heading3: {
    color: "#f4f8ff",
    fontSize: 16,
    fontWeight: "600" as const,
    marginTop: 10,
    marginBottom: 4,
    fontFamily: SYSTEM_FONT,
  },
  code_inline: {
    backgroundColor: "rgba(255,255,255,0.12)",
    color: "#d6ebff",
    borderRadius: 5,
    paddingHorizontal: 6,
    paddingVertical: 1.5,
    fontFamily: MONO_FONT,
    fontSize: 13.5,
  },
  code_block: {
    backgroundColor: "rgba(0,0,0,0.3)",
    color: "#e6edf3",
    borderRadius: 12,
    padding: 14,
    marginTop: 6,
    marginBottom: 12,
    fontFamily: MONO_FONT,
    fontSize: 13,
    lineHeight: 20,
  },
  fence: {
    backgroundColor: "rgba(0,0,0,0.3)",
    color: "#e6edf3",
    borderRadius: 12,
    padding: 14,
    marginTop: 6,
    marginBottom: 12,
    fontFamily: MONO_FONT,
    fontSize: 13,
    lineHeight: 20,
  },
  link: { color: "#93ccff" },
};

const selectableMarkdownRules: RenderRules = {
  text: (node, _children, _parent, styles, inheritedStyles = {}) => (
    <Text key={node.key} selectable style={[inheritedStyles, styles.text]}>
      {node.content}
    </Text>
  ),
  textgroup: (node, children, _parent, styles) => (
    <Text key={node.key} selectable style={styles.textgroup}>
      {children}
    </Text>
  ),
  strong: (node, children, _parent, styles) => (
    <Text key={node.key} selectable style={styles.strong}>
      {children}
    </Text>
  ),
  em: (node, children, _parent, styles) => (
    <Text key={node.key} selectable style={styles.em}>
      {children}
    </Text>
  ),
  s: (node, children, _parent, styles) => (
    <Text key={node.key} selectable style={styles.s}>
      {children}
    </Text>
  ),
  code_inline: (node, _children, _parent, styles, inheritedStyles = {}) => (
    <Text key={node.key} selectable style={[inheritedStyles, styles.code_inline]}>
      {node.content}
    </Text>
  ),
  code_block: (node, _children, _parent, styles, inheritedStyles = {}) => {
    let { content } = node;
    if (typeof node.content === "string" && node.content.charAt(node.content.length - 1) === "\n") {
      content = node.content.substring(0, node.content.length - 1);
    }

    const { backgroundColor, borderRadius, padding, marginTop, marginBottom, ...textStyle } = styles.code_block;
    return (
      <ScrollView
        key={node.key}
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ backgroundColor, borderRadius, marginTop, marginBottom }}
        contentContainerStyle={{ padding }}
      >
        <Text selectable style={[inheritedStyles, textStyle]}>
          {content}
        </Text>
      </ScrollView>
    );
  },
  fence: (node, _children, _parent, styles, inheritedStyles = {}) => {
    let { content } = node;
    if (typeof node.content === "string" && node.content.charAt(node.content.length - 1) === "\n") {
      content = node.content.substring(0, node.content.length - 1);
    }

    const { backgroundColor, borderRadius, padding, marginTop, marginBottom, ...textStyle } = styles.fence;
    return (
      <ScrollView
        key={node.key}
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ backgroundColor, borderRadius, marginTop, marginBottom }}
        contentContainerStyle={{ padding }}
      >
        <Text selectable style={[inheritedStyles, textStyle]}>
          {content}
        </Text>
      </ScrollView>
    );
  },
  hardbreak: (node, _children, _parent, styles) => (
    <Text key={node.key} selectable style={styles.hardbreak}>
      {"\n"}
    </Text>
  ),
  softbreak: (node, _children, _parent, styles) => (
    <Text key={node.key} selectable style={styles.softbreak}>
      {"\n"}
    </Text>
  ),
  inline: (node, children, _parent, styles) => (
    <Text key={node.key} selectable style={styles.inline}>
      {children}
    </Text>
  ),
  span: (node, children, _parent, styles) => (
    <Text key={node.key} selectable style={styles.span}>
      {children}
    </Text>
  ),
};

function parseSsePayload(raw: string): CodexSseEvent | null {
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

function extractReasoningText(params: unknown): string {
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

function formatReasoningDetail(detail: string): string {
  const trimmed = detail.trim();
  if (!trimmed) {
    return "";
  }

  const lines = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let normalized = trimmed;
  const singleTokenLines = lines.filter((line) => !line.includes(" ")).length;
  if (lines.length >= 3 && singleTokenLines / lines.length >= 0.6) {
    normalized = lines.join(" ");
  }

  normalized = normalized.replace(/\*\*(.+?)\*\*/g, "$1");
  normalized = normalized.replace(/[ \t]{2,}/g, " ");
  return normalized.trim();
}

function turnsSignature(items: RenderedTurn[]): string {
  return items
    .map((item) => `${item.id}:${item.role}:${item.kind ?? "message"}:${item.text.length}:${item.images?.length ?? 0}`)
    .join("|");
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstNonEmptyString(...values: unknown[]): string | null {
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

function isLikelyWebSearchToolName(value: string): boolean {
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

function extractWebSearchQueries(value: unknown): string[] {
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

function toWebSearchActivity(queries: string[]): { title: string; detail?: string } {
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

function normalizePathForChangeKey(rawPath: string): string {
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

function changeSummarySignature(summary: NonNullable<RenderedTurn["summary"]>, turnAnchor = ""): string {
  const files = summary.files
    .map((file) => `${normalizePathForChangeKey(file.path)}:${file.additions}:${file.deletions}`)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .join(";");
  return `change:${turnAnchor}:${files}`;
}

function turnContentSignature(item: RenderedTurn): string {
  const turnAnchor = item.turnId ?? "";
  if (item.kind === "changeSummary" && item.summary) {
    return changeSummarySignature(item.summary, turnAnchor);
  }
  if (item.kind === "activity" && item.activity) {
    return `activity:${turnAnchor}:${item.activity.title}:${item.activity.detail ?? ""}`;
  }
  return `msg:${turnAnchor}:${item.role}:${item.text}:${(item.images ?? []).join(",")}`;
}

function parseFilesFromUnifiedDiff(diffText: string): Array<{
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

function isLikelyUnifiedDiff(value: string): boolean {
  const text = value.trim();
  if (text.length === 0) {
    return false;
  }
  if (text.includes("diff --git")) {
    return true;
  }
  return text.includes("@@") && text.includes("--- ") && text.includes("+++ ");
}

function extractChangeSummaryFromEvent(method: string, params: unknown): RenderedTurn["summary"] | null {
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

function extractActivityFromEvent(method: string, params: unknown): RenderedTurn | null {
  const lower = method.toLowerCase();

  if (lower === "thread/compacted") {
    return {
      id: `activity-compact-${Date.now()}`,
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
      id: `activity-search-${Date.now()}`,
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
    const responseId = `raw-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

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
  const itemId = typeof threadItem.id === "string" ? threadItem.id : `${Date.now()}`;

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

function toPersistedEventTurns(
  events: Array<{ id: number; method: string; params?: unknown; createdAt?: string; turnId?: string }>,
  existing: RenderedTurn[]
): RenderedTurn[] {
  const merged = [...existing];
  const seen = new Set(merged.map((item) => turnContentSignature(item)));
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

  for (const event of events) {
    const createdAtMs = parseTimestampMs(event.createdAt);
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
      const signature = turnContentSignature(candidate);
      if (!seen.has(signature)) {
        seen.add(signature);
        insertCandidate(candidate);
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

function useSmoothedFlag(value: boolean, exitDelayMs = 180): boolean {
  const [smoothed, setSmoothed] = useState(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    if (value) {
      setSmoothed(true);
      return;
    }

    if (!smoothed) {
      return;
    }

    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setSmoothed(false);
    }, exitDelayMs);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [exitDelayMs, smoothed, value]);

  return smoothed;
}

function ThinkingShinyPill() {
  return (
    <MotiView
      from={{ opacity: 0, translateY: 8 }}
      animate={{ opacity: 1, translateY: 0 }}
      exit={{ opacity: 0, translateY: -4 }}
      transition={{ type: "timing", duration: 300 }}
      className="pb-4 pt-2"
    >
      <MotiView
        from={{ translateY: 0 }}
        animate={{ translateY: -3 }}
        transition={{ type: "timing", duration: 1400, loop: true, repeatReverse: true }}
      >
        <View className="relative self-start overflow-hidden rounded-full border border-white/20 bg-white/5 px-4 py-2">
          <MotiView
            from={{ translateX: -160, opacity: 0 }}
            animate={{ translateX: 240, opacity: 0.6 }}
            transition={{ type: "timing", duration: 1400, loop: true, repeatReverse: false }}
            className="absolute -bottom-8 -top-8 w-20 bg-white/30"
            style={{
              transform: [{ rotate: "18deg" }],
            }}
          />
          <MotiView
            from={{ translateX: -100, opacity: 0 }}
            animate={{ translateX: 240, opacity: 0.3 }}
            transition={{ type: "timing", duration: 1800, loop: true, repeatReverse: false, delay: 400 }}
            className="absolute -bottom-8 -top-8 w-10 bg-white/20"
            style={{
              transform: [{ rotate: "18deg" }],
            }}
          />
          <View className="relative flex-row items-center gap-2">
            <MotiView
              from={{ opacity: 0.4 }}
              animate={{ opacity: 1 }}
              transition={{ type: "timing", duration: 800, loop: true, repeatReverse: true }}
            >
              <Ionicons name="sparkles-outline" size={14} color="#ffffff" />
            </MotiView>
            <Text className="text-sm font-semibold text-white">Thinking</Text>
            <View className="flex-row items-center gap-1">
              <MotiView
                from={{ opacity: 0.2, scale: 0.7 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ type: "timing", duration: 500, loop: true, repeatReverse: true, delay: 0 }}
                className="h-1.5 w-1.5 rounded-full bg-white"
              />
              <MotiView
                from={{ opacity: 0.2, scale: 0.7 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ type: "timing", duration: 500, loop: true, repeatReverse: true, delay: 150 }}
                className="h-1.5 w-1.5 rounded-full bg-white"
              />
              <MotiView
                from={{ opacity: 0.2, scale: 0.7 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ type: "timing", duration: 500, loop: true, repeatReverse: true, delay: 300 }}
                className="h-1.5 w-1.5 rounded-full bg-white"
              />
            </View>
          </View>
        </View>
      </MotiView>
    </MotiView>
  );
}

function findActiveMentionToken(text: string, cursor: number): MentionToken | null {
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

function sanitizeAssistantDisplayText(text: string): string {
  const cleaned = text
    .split(/\r?\n/)
    .filter((line) => !DIRECTIVE_LINE_PATTERN.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
  return cleaned.trim();
}

function extractApiErrorMessage(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const message =
      (typeof parsed.error === "string" && parsed.error) ||
      (typeof parsed.message === "string" && parsed.message) ||
      null;
    const detail = typeof parsed.detail === "string" && parsed.detail ? parsed.detail : null;
    if (message && detail) {
      return `${message} (${detail})`;
    }
    return message || detail || trimmed;
  } catch {
    return trimmed;
  }
}

export default function ThreadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const threadId = useMemo(() => (Array.isArray(id) ? id[0] : id), [id]);
  const insets = useSafeAreaInsets();

  const [turns, setTurns] = useState<RenderedTurn[]>([]);
  const [composerText, setComposerText] = useState("");
  const [composerSelection, setComposerSelection] = useState<ComposerSelection>({ start: 0, end: 0 });
  const [mentionFiles, setMentionFiles] = useState<string[]>([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [mentionError, setMentionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamingAssistant, setStreamingAssistant] = useState("");
  const [streamingTerminalOutput, setStreamingTerminalOutput] = useState("");
  const [streamingReasoning, setStreamingReasoning] = useState("");
  const [streamingPlan, setStreamingPlan] = useState("");
  const [streamingFileChanges, setStreamingFileChanges] = useState("");
  const [streamingToolProgress, setStreamingToolProgress] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [selectedReasoning, setSelectedReasoning] = useState<ReasoningEffort | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [expandedActivityIds, setExpandedActivityIds] = useState<Set<string>>(new Set());
  const [expandedTerminalIds, setExpandedTerminalIds] = useState<Set<string>>(new Set());
  const [streamStatus, setStreamStatus] = useState<{ tone: StreamStatusTone; text: string }>({
    tone: "warn",
    text: "Connecting",
  });
  const [showLiveIndicator, setShowLiveIndicator] = useState(true);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [reasoningOptionsByModel, setReasoningOptionsByModel] = useState<Record<string, ReasoningOption[]>>({});
  const [optionsLoaded, setOptionsLoaded] = useState(false);
  const [openDropdown, setOpenDropdown] = useState<OpenDropdown>(null);
  const [previewImageUri, setPreviewImageUri] = useState<string | null>(null);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [headerTitle, setHeaderTitle] = useState("Chat");
  const [headerPath, setHeaderPath] = useState<string | null>(null);
  const [lastCopiedTurnId, setLastCopiedTurnId] = useState<string | null>(null);
  const [lastCopiedDiffId, setLastCopiedDiffId] = useState<string | null>(null);
  const [wrappedDiffIds, setWrappedDiffIds] = useState<Set<string>>(new Set());
  const [wrapToast, setWrapToast] = useState<{ diffId: string; wrapped: boolean } | null>(null);

  const streamSocketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const liveIndicatorHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const optionsRefreshPromiseRef = useRef<Promise<void> | null>(null);
  const selectedModelRef = useRef<string | null>(null);
  const composerInputRef = useRef<TextInput>(null);
  const listRef = useRef<FlatList<RenderedTurn>>(null);
  const followBottomRef = useRef(true);
  const draggingRef = useRef(false);
  const initialSnapDoneRef = useRef(false);
  const seenEventIdsRef = useRef(new Set<string>());
  const seenChangeHashesRef = useRef(new Set<string>());
  const turnsSignatureRef = useRef("");
  const mentionRequestRef = useRef(0);
  const wrapToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeMention = useMemo(
    () => findActiveMentionToken(composerText, composerSelection.start),
    [composerSelection.start, composerText]
  );

  const currentReasoningOptions = useMemo(() => {
    if (!selectedModel) {
      return [] as ReasoningOption[];
    }
    return reasoningOptionsByModel[selectedModel] ?? [];
  }, [reasoningOptionsByModel, selectedModel]);

  const resolvedSelectedModel = useMemo(
    () => (modelOptions.some((option) => option.value === selectedModel) ? selectedModel : null),
    [modelOptions, selectedModel]
  );

  const resolvedSelectedReasoning = useMemo(
    () =>
      currentReasoningOptions.some((option) => option.value === selectedReasoning)
        ? selectedReasoning
        : null,
    [currentReasoningOptions, selectedReasoning]
  );

  useEffect(() => {
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const showSub = Keyboard.addListener(showEvent, () => setKeyboardVisible(true));
    const hideSub = Keyboard.addListener(hideEvent, () => setKeyboardVisible(false));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  useEffect(() => {
    if (selectedReasoning === null) {
      return;
    }
    const allowed = currentReasoningOptions.some((option) => option.value === selectedReasoning);
    if (!allowed) {
      setSelectedReasoning(null);
    }
  }, [currentReasoningOptions, selectedReasoning]);

  useEffect(() => {
    if (selectedModel === null) {
      return;
    }
    const allowed = modelOptions.some((option) => option.value === selectedModel);
    if (!allowed) {
      setSelectedModel(null);
    }
  }, [modelOptions, selectedModel]);

  useEffect(() => {
    selectedModelRef.current = selectedModel;
  }, [selectedModel]);

  useEffect(() => {
    if (liveIndicatorHideTimerRef.current) {
      clearTimeout(liveIndicatorHideTimerRef.current);
      liveIndicatorHideTimerRef.current = null;
    }

    if (streamStatus.tone !== "ok") {
      setShowLiveIndicator(true);
      return;
    }

    if (streamStatus.text === "Live") {
      setShowLiveIndicator(true);
      liveIndicatorHideTimerRef.current = setTimeout(() => {
        setShowLiveIndicator(false);
      }, 1000);
    } else {
      setShowLiveIndicator(true);
    }

    return () => {
      if (liveIndicatorHideTimerRef.current) {
        clearTimeout(liveIndicatorHideTimerRef.current);
        liveIndicatorHideTimerRef.current = null;
      }
    };
  }, [streamStatus.tone, streamStatus.text]);

  const loadGatewayOptions = useCallback(async () => {
    const payload = await getGatewayOptions();

    const nextModelOptions: ModelOption[] = [];
    const nextReasoningByModel: Record<string, ReasoningOption[]> = {};

    for (const model of payload.models) {
      nextModelOptions.push({
        label: model.label,
        value: model.model,
      });

      const modelReasoningOptions: ReasoningOption[] = [];
      for (const effort of model.supportedReasoningEfforts) {
        if (effort === "none") {
          continue;
        }
        const label = effort.charAt(0).toUpperCase() + effort.slice(1);
        modelReasoningOptions.push({
          label,
          value: effort,
        });
      }

      if (modelReasoningOptions.length === 0) {
        modelReasoningOptions.push(...DEFAULT_REASONING_OPTIONS);
      }

      nextReasoningByModel[model.model] = modelReasoningOptions;
    }

    setModelOptions(nextModelOptions);
    setReasoningOptionsByModel(nextReasoningByModel);

    const nextModelValue = (() => {
      const currentSelectedModel = selectedModelRef.current;
      if (currentSelectedModel && nextModelOptions.some((option) => option.value === currentSelectedModel)) {
        return currentSelectedModel;
      }
      if (payload.defaultModel && nextModelOptions.some((option) => option.value === payload.defaultModel)) {
        return payload.defaultModel;
      }
      return nextModelOptions[0]?.value ?? null;
    })();

    setSelectedModel((current) => {
      if (current && nextModelOptions.some((option) => option.value === current)) {
        return current;
      }
      if (payload.defaultModel && nextModelOptions.some((option) => option.value === payload.defaultModel)) {
        return payload.defaultModel;
      }
      const firstRealModel = nextModelOptions[0]?.value ?? null;
      if (firstRealModel) {
        return firstRealModel;
      }
      return null;
    });

    setSelectedReasoning((current) => {
      if (current && current !== "none") {
        return current;
      }
      if (payload.defaultReasoningEffort && payload.defaultReasoningEffort !== "none") {
        return payload.defaultReasoningEffort;
      }
      const modelReasoning =
        (nextModelValue && nextReasoningByModel[nextModelValue]) || DEFAULT_REASONING_OPTIONS;
      return modelReasoning[0]?.value ?? null;
    });
    setOptionsLoaded(nextModelOptions.length > 0);
  }, []);

  const refreshGatewayOptionsIfNeeded = useCallback(async () => {
    if (optionsLoaded) {
      return;
    }
    if (optionsRefreshPromiseRef.current) {
      return optionsRefreshPromiseRef.current;
    }
    const refreshPromise = loadGatewayOptions().finally(() => {
      optionsRefreshPromiseRef.current = null;
    });
    optionsRefreshPromiseRef.current = refreshPromise;
    return refreshPromise;
  }, [loadGatewayOptions, optionsLoaded]);

  const markConnectionRecovered = useCallback(() => {
    setError(null);
    setStreamStatus((current) => (current.tone === "ok" && current.text === "Live" ? current : { tone: "ok", text: "Live" }));
    refreshGatewayOptionsIfNeeded().catch(() => {
      // Keep current options state if options endpoint is temporarily unavailable.
    });
  }, [refreshGatewayOptionsIfNeeded]);

  const flushStreamingAssistant = useCallback(() => {
    setStreamingAssistant((current) => {
      if (!current.trim()) {
        return "";
      }
      setTurns((existing) => [
        ...existing,
        {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          text: current,
        },
      ]);
      return "";
    });
  }, []);

  const flushStreamingTerminalOutput = useCallback(() => {
    setStreamingTerminalOutput((current) => {
      const normalized = current.trim();
      if (!normalized) {
        return "";
      }
      setTurns((existing) => [
        ...existing,
        {
          id: `terminal-${Date.now()}`,
          role: "system",
          text: "",
          kind: "activity",
          activity: {
            title: "Terminal output",
            detail: current,
          },
        },
      ]);
      return "";
    });
  }, []);

  const flushStreamingReasoning = useCallback(() => {
    setStreamingReasoning((current) => {
      const normalized = current.trim();
      if (!normalized) {
        return "";
      }
      setTurns((existing) => [
        ...existing,
        {
          id: `reasoning-${Date.now()}`,
          role: "system",
          text: "",
          kind: "activity",
          activity: {
            title: "Reasoning",
            detail: current,
          },
        },
      ]);
      return "";
    });
  }, []);

  const flushStreamingPlan = useCallback(() => {
    setStreamingPlan((current) => {
      const normalized = current.trim();
      if (!normalized) {
        return "";
      }
      setTurns((existing) => [
        ...existing,
        {
          id: `plan-${Date.now()}`,
          role: "system",
          text: "",
          kind: "activity",
          activity: {
            title: "Plan",
            detail: current,
          },
        },
      ]);
      return "";
    });
  }, []);

  const flushStreamingFileChanges = useCallback(() => {
    setStreamingFileChanges((current) => {
      const normalized = current.trim();
      if (!normalized) {
        return "";
      }
      setTurns((existing) => [
        ...existing,
        {
          id: `filechanges-${Date.now()}`,
          role: "system",
          text: "",
          kind: "activity",
          activity: {
            title: "File changes",
            detail: current,
          },
        },
      ]);
      return "";
    });
  }, []);

  const flushStreamingToolProgress = useCallback(() => {
    setStreamingToolProgress((current) => {
      const normalized = current.trim();
      if (!normalized) {
        return "";
      }
      setTurns((existing) => [
        ...existing,
        {
          id: `toolprogress-${Date.now()}`,
          role: "system",
          text: "",
          kind: "activity",
          activity: {
            title: "Tool progress",
            detail: current,
          },
        },
      ]);
      return "";
    });
  }, []);

  useEffect(() => {
    if (!threadId) {
      return;
    }

    let active = true;
    initialSnapDoneRef.current = false;
    followBottomRef.current = true;
    draggingRef.current = false;
    setShowScrollToBottom(false);
    setStreamingAssistant("");
    setStreamingTerminalOutput("");
    setStreamingReasoning("");
    setStreamingPlan("");
    setStreamingFileChanges("");
    setStreamingToolProgress("");
    setIsThinking(false);
    setActiveTurnId(null);
    setHeaderTitle("Chat");
    setHeaderPath(null);
    setTurns([]);
    setExpandedActivityIds(new Set());
    setExpandedTerminalIds(new Set());
    turnsSignatureRef.current = "";
    setStreamStatus({ tone: "warn", text: "Connecting" });
    reconnectAttemptRef.current = 0;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    const setup = async () => {
      setError(null);
      setLoading(true);

      const scheduleReconnect = () => {
        if (!active) {
          return;
        }
        const attempt = reconnectAttemptRef.current;
        const delayMs = Math.min(8000, 500 * 2 ** attempt);
        reconnectAttemptRef.current += 1;
        setStreamStatus({ tone: "warn", text: "Reconnecting" });
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          connectStream().catch(() => {
            scheduleReconnect();
          });
        }, delayMs);
      };

      const connectStream = async () => {
        const stream = await getStreamConfig(threadId);
        if (!active) {
          return;
        }

        streamSocketRef.current?.close();
        const socket = new WebSocket(stream.wsUrl);
        streamSocketRef.current = socket;

        socket.onopen = () => {
          reconnectAttemptRef.current = 0;
          markConnectionRecovered();
        };

        socket.onmessage = (event) => {
          const data = typeof event.data === "string" ? event.data : "";
          if (!data) {
            return;
          }

          const payload = parseSsePayload(data);
          if (!payload) {
            return;
          }

          const method = payload.method.toLowerCase();

          if (method === "stream/keepalive" || method === "stream/ready") {
            return;
          }

          if (method === "turn/started" || method === "item/started" || method.includes("reasoning") || method.includes("plan/")) {
            setIsThinking(true);
            if (method === "turn/started" && payload.params && typeof payload.params === "object") {
              const eventParams = payload.params as Record<string, unknown>;
              const turnId =
                (typeof eventParams.turnId === "string" && eventParams.turnId) ||
                (eventParams.turn &&
                typeof eventParams.turn === "object" &&
                typeof (eventParams.turn as Record<string, unknown>).id === "string"
                  ? ((eventParams.turn as Record<string, unknown>).id as string)
                  : null);
              if (turnId) {
                setActiveTurnId(turnId);
              }
            }
          }

          const activity = extractActivityFromEvent(method, payload.params);
          if (activity) {
            if (!seenEventIdsRef.current.has(activity.id)) {
              seenEventIdsRef.current.add(activity.id);
              setTurns((existing) => [...existing, activity]);
            }
            return;
          }

          const summary = extractChangeSummaryFromEvent(method, payload.params);
          if (summary) {
            const key = changeSummarySignature(summary);
            if (!seenChangeHashesRef.current.has(key)) {
              seenChangeHashesRef.current.add(key);
              setTurns((existing) => [
                ...existing,
                {
                  id: `change-${Date.now()}`,
                  role: "system",
                  text: "",
                  kind: "changeSummary",
                  summary,
                },
              ]);
            }
            return;
          }

          if (method.includes("commandexecution/outputdelta")) {
            const delta = extractDeltaText(payload.params);
            if (delta) {
              setStreamingTerminalOutput((existing) => `${existing}${delta}`);
            }
            return;
          }

          if (
            method.includes("reasoning/textdelta") ||
            method.includes("reasoning/summarytextdelta") ||
            method.includes("reasoning/summarypartadded")
          ) {
            const chunk = extractReasoningText(payload.params);
            if (chunk) {
              setStreamingReasoning((existing) => `${existing}${chunk}`);
            }
            return;
          }

          if (method.includes("item/plan/delta") || method.includes("turn/plan/updated")) {
            const delta = extractDeltaText(payload.params);
            const chunk =
              delta ||
              (payload.params && typeof payload.params === "object" ? JSON.stringify(payload.params, null, 2) : "");
            if (chunk) {
              setStreamingPlan((existing) => `${existing}${existing && !chunk.startsWith("\n") ? "\n" : ""}${chunk}`);
            }
            return;
          }

          if (method.includes("item/filechange/outputdelta")) {
            const delta = extractDeltaText(payload.params);
            const chunk =
              delta ||
              (payload.params && typeof payload.params === "object" ? JSON.stringify(payload.params, null, 2) : "");
            if (chunk) {
              setStreamingFileChanges((existing) => `${existing}${chunk}`);
            }
            return;
          }

          if (method.includes("item/mcptoolcall/progress")) {
            const progressRecord = payload.params && typeof payload.params === "object" ? (payload.params as Record<string, unknown>) : null;
            const progressToolName = firstNonEmptyString(
              progressRecord?.toolName,
              progressRecord?.tool_name,
              progressRecord?.name,
              progressRecord?.callName,
              progressRecord?.call_name
            );
            const progressQueries = extractWebSearchQueries(payload.params);
            if (progressQueries.length > 0 || isLikelyWebSearchToolName(progressToolName ?? "")) {
              const candidate: RenderedTurn = {
                id: `web-search-progress-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
                role: "system",
                text: "",
                kind: "activity",
                activity: toWebSearchActivity(progressQueries),
              };
              const candidateSignature = turnContentSignature(candidate);
              setTurns((existing) => {
                const alreadyPresent = existing.some(
                  (item) => item.kind === "activity" && item.activity && turnContentSignature(item) === candidateSignature
                );
                if (alreadyPresent) {
                  return existing;
                }
                return [...existing, candidate];
              });
            }

            const delta = extractDeltaText(payload.params);
            const chunk =
              delta ||
              (payload.params && typeof payload.params === "object" ? JSON.stringify(payload.params, null, 2) : "");
            if (chunk) {
              setStreamingToolProgress((existing) => `${existing}${existing && !chunk.startsWith("\n") ? "\n" : ""}${chunk}`);
            }
            return;
          }

          if (method.includes("agentmessage/delta")) {
            const delta = extractDeltaText(payload.params);
            if (delta) {
              setStreamingAssistant((existing) => `${existing}${delta}`);
            }
            return;
          }

          if (method.includes("aborted") || method.includes("interrupt")) {
            setIsThinking(false);
            setActiveTurnId(null);
            flushStreamingAssistant();
            flushStreamingTerminalOutput();
            flushStreamingReasoning();
            flushStreamingPlan();
            flushStreamingFileChanges();
            flushStreamingToolProgress();
            return;
          }

          if (method.includes("complete") || method.includes("done") || method.includes("turn/end")) {
            setIsThinking(false);
            setActiveTurnId(null);
            flushStreamingAssistant();
            flushStreamingTerminalOutput();
            flushStreamingReasoning();
            flushStreamingPlan();
            flushStreamingFileChanges();
            flushStreamingToolProgress();
          }
        };

        socket.onerror = () => {
          // Wait for onclose before transitioning to reconnect state.
          // Some environments can emit transient socket errors before stabilizing.
        };

        socket.onclose = () => {
          if (!active) {
            return;
          }
          if (streamSocketRef.current === socket) {
            streamSocketRef.current = null;
          }
          scheduleReconnect();
        };
      };

      try {
        await resumeThread(threadId);
        const [thread, eventsResponse, threadsResponse] = await Promise.all([
          getThread(threadId),
          getThreadEvents(threadId),
          getThreads(),
        ]);
        if (!active) {
          return;
        }

        const headerName = thread.name?.trim() || thread.title?.trim() || "Chat";
        const matchingSummary = threadsResponse.threads.find((entry) => entry.id === threadId);
        setHeaderTitle(headerName);
        setHeaderPath(matchingSummary?.cwd?.trim() || null);

        const initialTurns = toRenderedTurns(thread.turns);
        const withPersistedEvents = toPersistedEventTurns(eventsResponse.events, initialTurns);
        setTurns(withPersistedEvents);
        setError(null);
        turnsSignatureRef.current = turnsSignature(withPersistedEvents);
        seenChangeHashesRef.current = new Set(
          withPersistedEvents
            .filter((item) => item.kind === "changeSummary" && item.summary)
            .map((item) => turnContentSignature(item))
        );
        await connectStream();
      } catch (setupError) {
        if (setupError instanceof ReauthRequiredError) {
          await clearSession();
          router.replace("/pair");
          return;
        }
        setStreamStatus({ tone: "error", text: "Disconnected" });
        setError(setupError instanceof Error ? setupError.message : "Unable to load thread");
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    setup().catch(() => {
      setStreamStatus({ tone: "error", text: "Disconnected" });
      setError("Unable to load thread");
      setLoading(false);
    });

    return () => {
      active = false;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      streamSocketRef.current?.close();
      streamSocketRef.current = null;
    };
  }, [
    threadId,
    flushStreamingAssistant,
    flushStreamingTerminalOutput,
    flushStreamingReasoning,
    flushStreamingPlan,
    flushStreamingFileChanges,
    flushStreamingToolProgress,
  ]);

  useEffect(() => {
    if (!threadId) {
      return;
    }
    if (loading) {
      return;
    }

    const shouldSync = streamStatus.tone !== "ok";
    if (!shouldSync) {
      return;
    }

    let active = true;
    const timer = setInterval(async () => {
      try {
        const [thread, eventsResponse] = await Promise.all([getThread(threadId), getThreadEvents(threadId)]);
        if (!active) {
          return;
        }
        const rendered = toRenderedTurns(thread.turns);
        const withPersistedEvents = toPersistedEventTurns(eventsResponse.events, rendered);
        const nextSignature = turnsSignature(withPersistedEvents);
        if (nextSignature !== turnsSignatureRef.current) {
          turnsSignatureRef.current = nextSignature;
          setStreamingAssistant("");
          setStreamingTerminalOutput("");
          setStreamingReasoning("");
          setStreamingPlan("");
          setStreamingFileChanges("");
          setStreamingToolProgress("");
          setTurns(withPersistedEvents);
          seenChangeHashesRef.current = new Set(
            withPersistedEvents
              .filter((item) => item.kind === "changeSummary" && item.summary)
              .map((item) => turnContentSignature(item))
          );
        }
        markConnectionRecovered();
      } catch {
        // no-op: stream reconnect status already indicates issues
      }
    }, 2500);

    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [threadId, loading, streamStatus.tone, markConnectionRecovered]);

  useEffect(() => {
    let active = true;

    const loadOptions = async () => {
      try {
        await loadGatewayOptions();
        if (!active) {
          return;
        }
      } catch {
        if (!active) {
          return;
        }
        setOptionsLoaded(false);
        setModelOptions([]);
        setReasoningOptionsByModel({});
        setSelectedModel(null);
        setSelectedReasoning(null);
      }
    };

    loadOptions().catch(() => {
      // ignore, fallback options remain active
    });

    return () => {
      active = false;
    };
  }, [loadGatewayOptions]);

  const keepToBottom = (animated: boolean) => {
    listRef.current?.scrollToEnd({ animated });
    // Layout/stream deltas can continue arriving after the first scroll.
    setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 80);
    setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 220);
  };

  const streamDotColor =
    streamStatus.tone === "ok" ? "#22c55e" : streamStatus.tone === "warn" ? "#f59e0b" : "#ef4444";
  const indicatorVisible = showLiveIndicator || streamStatus.tone !== "ok";

  useEffect(() => {
    if (!followBottomRef.current) {
      return;
    }
    const timer = setTimeout(() => {
      keepToBottom(initialSnapDoneRef.current);
      if (!initialSnapDoneRef.current) {
        initialSnapDoneRef.current = true;
      }
    }, 40);
    return () => clearTimeout(timer);
  }, [turns, streamingAssistant, streamingTerminalOutput, streamingReasoning, streamingPlan, streamingFileChanges, streamingToolProgress]);

  const onListScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceFromBottom = contentSize.height - (contentOffset.y + layoutMeasurement.height);
    const isNearBottom = distanceFromBottom < 120;
    // If the user scrolls away from bottom, stop auto-following streamed tokens.
    followBottomRef.current = isNearBottom;
    setShowScrollToBottom(!isNearBottom);
  };

  const scrollToBottom = () => {
    followBottomRef.current = true;
    setShowScrollToBottom(false);
    keepToBottom(true);
  };

  const copyTurnText = useCallback(async (turnId: string, text?: string) => {
    if (!text) {
      return;
    }

    try {
      await Clipboard.setStringAsync(text);
      setLastCopiedTurnId(turnId);
      setTimeout(() => {
        setLastCopiedTurnId((existing) => (existing === turnId ? null : existing));
      }, 1200);
    } catch {
      // no-op: copy action should never break turn rendering.
    }
  }, []);

  const copyDiffText = useCallback(async (diffId: string, diffText?: string) => {
    if (!diffText) {
      return;
    }

    try {
      await Clipboard.setStringAsync(diffText);
      setLastCopiedDiffId(diffId);
      setTimeout(() => {
        setLastCopiedDiffId((existing) => (existing === diffId ? null : existing));
      }, 1200);
    } catch {
      // no-op
    }
  }, []);

  const toggleDiffWrap = useCallback((diffId: string) => {
    setWrappedDiffIds((existing) => {
      const next = new Set(existing);
      let wrapped = true;
      if (next.has(diffId)) {
        next.delete(diffId);
        wrapped = false;
      } else {
        next.add(diffId);
      }
      setWrapToast({ diffId, wrapped });
      if (wrapToastTimerRef.current) {
        clearTimeout(wrapToastTimerRef.current);
      }
      wrapToastTimerRef.current = setTimeout(() => {
        setWrapToast((current) => (current?.diffId === diffId ? null : current));
        wrapToastTimerRef.current = null;
      }, 1000);
      return next;
    });
  }, []);

  useEffect(() => {
    return () => {
      if (wrapToastTimerRef.current) {
        clearTimeout(wrapToastTimerRef.current);
        wrapToastTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!threadId || !activeMention) {
      setMentionFiles([]);
      setMentionLoading(false);
      setMentionError(null);
      return;
    }

    let active = true;
    const requestId = mentionRequestRef.current + 1;
    mentionRequestRef.current = requestId;
    setMentionLoading(true);
    setMentionError(null);

    const timer = setTimeout(async () => {
      try {
        const payload = await getThreadFiles(threadId, {
          query: activeMention.query,
          limit: 200,
        });

        if (!active || mentionRequestRef.current !== requestId) {
          return;
        }
        setMentionFiles(payload.files);
      } catch (mentionFetchError) {
        if (!active || mentionRequestRef.current !== requestId) {
          return;
        }
        setMentionFiles([]);
        if (mentionFetchError instanceof ApiHttpError) {
          if (mentionFetchError.status === 404) {
            setMentionError("Files API unavailable. Restart gateway.");
          } else {
            const serverMessage = extractApiErrorMessage(mentionFetchError.body);
            setMentionError(serverMessage ?? `Request failed (${mentionFetchError.status})`);
          }
        } else {
          setMentionError(mentionFetchError instanceof Error ? mentionFetchError.message : "Unable to load files");
        }
      } finally {
        if (active && mentionRequestRef.current === requestId) {
          setMentionLoading(false);
        }
      }
    }, 80);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [activeMention, threadId]);

  const applyMentionSelection = useCallback(
    (filePath: string) => {
      if (!activeMention) {
        return;
      }
      const nextText = `${composerText.slice(0, activeMention.start)}@${filePath} ${composerText.slice(activeMention.end)}`;
      const nextCursor = activeMention.start + filePath.length + 2;
      setComposerText(nextText);
      setComposerSelection({ start: nextCursor, end: nextCursor });
      setMentionFiles([]);
      setMentionError(null);
      setTimeout(() => {
        composerInputRef.current?.focus();
      }, 10);
    },
    [activeMention, composerText]
  );

  const onSend = async () => {
    if (!threadId || sending) {
      return;
    }
    const text = composerText.trim();
    if (!text && pendingImages.length === 0) {
      return;
    }

    Keyboard.dismiss();
    const queuedImages = pendingImages;
    setComposerText("");
    setComposerSelection({ start: 0, end: 0 });
    setMentionFiles([]);
    setMentionError(null);
    setPendingImages([]);
    setSending(true);
    setError(null);

    setTurns((existing) => [
      ...existing,
      {
        id: `local-user-${Date.now()}`,
        role: "user",
        text,
        images: queuedImages.map((image) => image.uri),
      },
    ]);
    followBottomRef.current = true;

    try {
      const response = await sendThreadMessage(threadId, {
        text: text || undefined,
        images: queuedImages.map((image) => ({ imageUrl: image.imageUrl })),
        model: resolvedSelectedModel ?? undefined,
        reasoningEffort: resolvedSelectedReasoning ?? undefined,
      });
      if (response.turnId) {
        setActiveTurnId(response.turnId);
      }
    } catch (sendError) {
      if (sendError instanceof ReauthRequiredError) {
        await clearSession();
        router.replace("/pair");
        return;
      }
      setError(sendError instanceof Error ? sendError.message : "Unable to send message");
    } finally {
      setSending(false);
    }
  };

  const onStopResponse = useCallback(async () => {
    if (!threadId || stopping) {
      return;
    }
    if (!activeTurnId) {
      setError("Unable to stop response right now. Please try again in a moment.");
      return;
    }

    setStopping(true);
    try {
      await interruptThreadTurn(threadId, { turnId: activeTurnId });
      setIsThinking(false);
      setActiveTurnId(null);
      flushStreamingAssistant();
      flushStreamingTerminalOutput();
      flushStreamingReasoning();
      flushStreamingPlan();
      flushStreamingFileChanges();
      flushStreamingToolProgress();
      setError(null);
    } catch (interruptError) {
      setError(interruptError instanceof Error ? interruptError.message : "Unable to stop response");
    } finally {
      setStopping(false);
    }
  }, [
    activeTurnId,
    flushStreamingAssistant,
    flushStreamingTerminalOutput,
    flushStreamingReasoning,
    flushStreamingPlan,
    flushStreamingFileChanges,
    flushStreamingToolProgress,
    stopping,
    threadId,
  ]);

  const onPickImages = useCallback(async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsMultipleSelection: true,
        quality: 0.7,
        base64: false,
      });

      if (result.canceled || !result.assets.length) {
        return;
      }

      const nextImages = (
        await Promise.all(
          result.assets.map(async (asset, index): Promise<PendingImage | null> => {
            const normalized = await ImageManipulator.manipulateAsync(asset.uri, [], {
              compress: 0.8,
              format: ImageManipulator.SaveFormat.JPEG,
              base64: true,
            });

            if (!normalized.base64) {
              return null;
            }

            return {
              id: `${Date.now()}-${index}-${asset.assetId ?? asset.uri}`,
              uri: normalized.uri,
              imageUrl: `data:image/jpeg;base64,${normalized.base64}`,
            };
          })
        )
      ).filter((image): image is PendingImage => image !== null);

      if (!nextImages.length) {
        setError("Unable to attach selected image.");
        return;
      }

      setPendingImages((existing) => [...existing, ...nextImages]);
      setError(null);
    } catch (pickError) {
      setError(pickError instanceof Error ? pickError.message : "Unable to pick image");
    }
  }, []);

  const isResponding =
    sending ||
    isThinking ||
    streamingAssistant.trim().length > 0 ||
    streamingTerminalOutput.trim().length > 0 ||
    streamingReasoning.trim().length > 0 ||
    streamingPlan.trim().length > 0 ||
    streamingFileChanges.trim().length > 0 ||
    streamingToolProgress.trim().length > 0;
  const smoothIsThinking = useSmoothedFlag(isThinking, 240);
  const composerHasDraft = composerText.trim().length > 0 || pendingImages.length > 0;
  const composerActionIconName = isResponding
    ? stopping
      ? "time-outline"
      : "stop-circle-outline"
    : sending
    ? "time-outline"
    : "arrow-up";
  const showMentionSuggestions = Boolean(activeMention);
  const mentionSuggestions = mentionFiles.slice(0, 12);

  const allTurns = [
    ...turns,
    ...(streamingAssistant
      ? [
          {
            id: "live-assistant",
            role: "assistant" as const,
            text: streamingAssistant,
            streaming: true,
          },
        ]
      : []),
    ...(streamingReasoning
      ? [
          {
            id: "live-reasoning",
            role: "system" as const,
            text: "",
            kind: "activity" as const,
            activity: {
              title: "Reasoning",
              detail: streamingReasoning,
            },
            streaming: true,
          },
        ]
      : []),
    ...(streamingPlan
      ? [
          {
            id: "live-plan",
            role: "system" as const,
            text: "",
            kind: "activity" as const,
            activity: {
              title: "Plan",
              detail: streamingPlan,
            },
            streaming: true,
          },
        ]
      : []),
    ...(streamingFileChanges
      ? [
          {
            id: "live-filechanges",
            role: "system" as const,
            text: "",
            kind: "activity" as const,
            activity: {
              title: "File changes",
              detail: streamingFileChanges,
            },
            streaming: true,
          },
        ]
      : []),
    ...(streamingToolProgress
      ? [
          {
            id: "live-toolprogress",
            role: "system" as const,
            text: "",
            kind: "activity" as const,
            activity: {
              title: "Tool progress",
              detail: streamingToolProgress,
            },
            streaming: true,
          },
        ]
      : []),
    ...(streamingTerminalOutput
      ? [
          {
            id: "live-terminal",
            role: "system" as const,
            text: "",
            kind: "activity" as const,
            activity: {
              title: "Terminal output",
              detail: streamingTerminalOutput,
            },
            streaming: true,
          },
        ]
      : []),
  ];

  const copyGroupKeyForTurn = useCallback((turn: RenderedTurn) => `${turn.role}:${turn.turnId ?? turn.id}`, []);

  const copyGroups = useMemo(() => {
    const lastIndexByKey = new Map<string, number>();
    const textPartsByKey = new Map<string, string[]>();

    allTurns.forEach((turn, idx) => {
      if (turn.role !== "user" && turn.role !== "assistant") {
        return;
      }

      const groupKey = copyGroupKeyForTurn(turn);
      lastIndexByKey.set(groupKey, idx);

      const normalized = turn.text.trim();
      if (!normalized) {
        return;
      }

      const existing = textPartsByKey.get(groupKey) ?? [];
      existing.push(normalized);
      textPartsByKey.set(groupKey, existing);
    });

    const textByKey = new Map<string, string>();
    textPartsByKey.forEach((parts, key) => {
      textByKey.set(key, parts.join("\n\n"));
    });

    return { lastIndexByKey, textByKey };
  }, [allTurns, copyGroupKeyForTurn]);

  const resolveWebSearchFallback = useCallback(
    (turnIndex: number): string | null => {
      for (let index = turnIndex - 1; index >= 0; index -= 1) {
        const candidate = allTurns[index];
        if (candidate.role !== "user") {
          continue;
        }
        const text = candidate.text.trim();
        if (text.length > 0) {
          return text;
        }
      }
      return null;
    },
    [allTurns]
  );

  const diffLineToneClassName = (line: string): string => {
    if (line.startsWith("@@")) {
      return "text-slate-400";
    }
    if (line.startsWith("+")) {
      return "text-emerald-400";
    }
    if (line.startsWith("-")) {
      return "text-red-400";
    }
    return "text-muted-foreground";
  };

  const toDisplayDiffLines = (
    diffText: string
  ): Array<{ lineNumber: number | null; line: string; tone: string }> => {
    const rawLines = diffText.split("\n");
    const filtered = rawLines.filter(
      (line) =>
        !line.startsWith("diff --git") &&
        !line.startsWith("index ") &&
        !line.startsWith("--- ") &&
        !line.startsWith("+++ ")
    );

    let oldLineCursor: number | null = null;
    let newLineCursor: number | null = null;

    return filtered.map((line) => {
      const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunkMatch) {
        oldLineCursor = Number.parseInt(hunkMatch[1] ?? "0", 10);
        newLineCursor = Number.parseInt(hunkMatch[2] ?? "0", 10);
        return {
          lineNumber: null,
          line,
          tone: diffLineToneClassName(line),
        };
      }

      if (line.startsWith("+")) {
        const lineNumber = newLineCursor;
        newLineCursor = (newLineCursor ?? 0) + 1;
        return {
          lineNumber,
          line,
          tone: diffLineToneClassName(line),
        };
      }

      if (line.startsWith("-")) {
        const lineNumber = oldLineCursor;
        oldLineCursor = (oldLineCursor ?? 0) + 1;
        return {
          lineNumber,
          line,
          tone: diffLineToneClassName(line),
        };
      }

      if (line.startsWith(" ")) {
        const lineNumber = newLineCursor ?? oldLineCursor;
        if (newLineCursor !== null) {
          newLineCursor += 1;
        }
        if (oldLineCursor !== null) {
          oldLineCursor += 1;
        }
        return {
          lineNumber,
          line,
          tone: diffLineToneClassName(line),
        };
      }

      return {
        lineNumber: null,
        line,
        tone: diffLineToneClassName(line),
      };
    });
  };

  return (
    <SafeAreaView className="flex-1 bg-background" edges={["top", "left", "right"]}>
      <KeyboardAvoidingView className="flex-1" behavior={Platform.OS === "ios" ? "padding" : "height"} keyboardVerticalOffset={0}>
        <View className="flex-1 bg-background px-4 pt-1">
      <View className="-mx-4 mb-3 border-b border-border/50 pb-2 px-4">
      <View className="relative h-12 justify-center">
          <View className="absolute bottom-0 left-0 top-0 z-10 justify-center">
            <Pressable
              onPress={() => router.back()}
              className="self-start h-10 w-10 items-center justify-center"
            >
              <Ionicons name="chevron-back" size={24} color="#ffffff" />
            </Pressable>
          </View>

          <View className="px-12">
            <View className="items-center">
              <Text className="text-2xl font-semibold text-foreground" numberOfLines={1}>
                {headerTitle}
              </Text>
              <MotiView
                animate={{ opacity: headerPath ? 1 : 0, translateY: headerPath ? 0 : -4, height: headerPath ? 16 : 0 }}
                transition={{ type: "timing", duration: 220 }}
                style={{ overflow: "hidden", width: "100%", alignItems: "center" }}
              >
                <Text className="text-[11px] leading-[14px] text-muted-foreground" numberOfLines={1}>
                  {headerPath ? formatPathForDisplay(headerPath) : ""}
                </Text>
              </MotiView>
            </View>
          </View>

          <View className="absolute bottom-0 right-0 top-0 z-10 items-end justify-center">
            <MotiView
              animate={{ opacity: indicatorVisible ? 1 : 0, scale: indicatorVisible ? 1 : 0.97 }}
              transition={{ type: "timing", duration: 1000 }}
            >
              <View className="flex-row items-center rounded-full border border-border/10 bg-card px-2.5 py-1.5">
                <View className="mr-1.5 h-2 w-2 rounded-full" style={{ backgroundColor: streamDotColor }} />
                <Text className="text-xs font-semibold text-foreground">{streamStatus.text}</Text>
              </View>
            </MotiView>
          </View>
        </View>
        </View>
        {/* <Text className="mb-2 text-[11px] font-semibold uppercase tracking-[1.2px] text-muted-foreground">ID</Text>
        <Text className="mb-3 rounded-xl border border-border/10 bg-muted px-3 py-2 text-xs text-muted-foreground">{threadId}</Text> */}

        {error ? (
          <View className="mb-3 rounded-xl border border-border/10 bg-destructive/15 p-3">
            <Text className="text-sm text-destructive-foreground">{error}</Text>
          </View>
        ) : null}

        <FlatList
          ref={listRef}
          data={allTurns}
          keyExtractor={(item) => item.id}
          className="flex-1"
          style={{ marginHorizontal: -16 }}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 16 }}
          indicatorStyle="white"
          scrollIndicatorInsets={{ right: 1 }}
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          keyboardShouldPersistTaps="handled"
          onScroll={onListScroll}
          onScrollBeginDrag={() => {
            draggingRef.current = true;
          }}
          onScrollEndDrag={() => {
            draggingRef.current = false;
          }}
          onMomentumScrollEnd={() => {
            draggingRef.current = false;
          }}
          onContentSizeChange={() => {
            if (followBottomRef.current) {
              keepToBottom(initialSnapDoneRef.current);
              if (!initialSnapDoneRef.current) {
                initialSnapDoneRef.current = true;
              }
            }
          }}
          scrollEventThrottle={16}
          renderItem={({ item, index }) => (
            <MotiView
              from={{ opacity: 0, translateY: 6 }}
              animate={{ opacity: 1, translateY: 0 }}
              transition={{ type: "timing", delay: Math.min(index, 8) * 18, duration: 160 }}
              className={`mb-2 w-full ${item.role === "user" ? "items-end" : "items-start"}`}
            >
              {item.kind === "changeSummary" && item.summary ? (
                <View className="w-full rounded-2xl border border-border/10 bg-card px-4 py-4">
                  <Text className="text-lg font-bold text-card-foreground">
                    {item.summary.displayKind === "preview"
                      ? "Diff preview"
                      : `${item.summary.filesChanged} file${item.summary.filesChanged === 1 ? "" : "s"} changed`}
                  </Text>
                  {item.summary.files.map((file) => {
                    const diffId = `${item.id}:${file.path}`;
                    const isWrapped = wrappedDiffIds.has(diffId);
                    return (
                    <View key={`${item.id}-${file.path}`} className="">
                      <View className="flex-row items-center justify-between">
                        <Text className="max-w-[70%] flex-shrink text-xs leading-5 text-foreground">
                          {file.path}
                        </Text>
                        <Text className="text-lg font-semibold">
                          <Text className="text-emerald-400">+{file.additions}</Text>
                          <Text className="text-red-400"> -{file.deletions}</Text>
                        </Text>
                      </View>
                      {typeof file.diff === "string" && file.diff.length > 0 ? (
                        <View className="mt-2 rounded-lg border border-border/40 bg-muted/60 px-2.5 py-2">
                          <View className="mb-1 flex-row justify-end">
                            <View className="relative mr-1">
                              <AnimatePresence>
                                {wrapToast?.diffId === diffId ? (
                                  <MotiView
                                    key={`wrap-toast-${diffId}`}
                                    from={{ opacity: 0, translateY: 4, scale: 0.97 }}
                                    animate={{ opacity: 1, translateY: 0, scale: 1 }}
                                    exit={{ opacity: 0, translateY: -4, scale: 0.97 }}
                                    transition={{ type: "timing", duration: 170 }}
                                    className="absolute -top-0 right-full z-20 w-[100px] items-center rounded-full bg-black/20 px-2.5 py-2 mr-0.5"
                                  >
                                    <Text className="text-sm text-primary-foreground">
                                      Word wrap {wrapToast.wrapped ? "ON" : "OFF"}
                                    </Text>
                                  </MotiView>
                                ) : null}
                              </AnimatePresence>
                              <Pressable
                                onPress={() => toggleDiffWrap(diffId)}
                                className="flex-row items-center justify-center rounded-full bg-black/20 px-2.5 py-2.5"
                              >
                                <Ionicons
                                  name={isWrapped ? "arrow-forward-outline" : "return-down-back-outline"}
                                  size={12}
                                  className="text-primary-foreground"
                                />
                              </Pressable>
                            </View>
                            <Pressable
                              onPress={() => copyDiffText(diffId, file.diff)}
                              className="flex-row items-center justify-center rounded-full bg-black/20 px-2.5 py-2.5"
                            >
                              <Ionicons
                                name={lastCopiedDiffId === diffId ? "checkmark" : "copy-outline"}
                                size={12}
                                className="text-primary-foreground"
                              />
                            </Pressable>
                          </View>
                          {(() => {
                            const diffLines = toDisplayDiffLines(file.diff);
                            return (
                              <>
                                {isWrapped ? (
                                  <View className="pr-2">
                                    {diffLines.map(({ lineNumber, line, tone }, lineIndex) => (
                                      <View key={`${item.id}-${file.path}-line-row-${lineIndex}`} className="flex-row items-start">
                                        <Text className="w-9 pr-2 text-right text-[10px] leading-5 text-slate-500">
                                          {lineNumber ?? ""}
                                        </Text>
                                        <Text
                                          className={`flex-1 text-[12px] leading-5 ${tone}`}
                                          style={{ fontFamily: MONO_FONT, fontWeight: "600" }}
                                        >
                                          {line.length > 0 ? line : " "}
                                        </Text>
                                      </View>
                                    ))}
                                  </View>
                                ) : (
                                  <ScrollView horizontal showsHorizontalScrollIndicator>
                                    <View className="pr-2">
                                      {diffLines.map(({ lineNumber, line, tone }, lineIndex) => (
                                        <View key={`${item.id}-${file.path}-line-row-${lineIndex}`} className="flex-row items-start">
                                          <Text className="w-9 pr-2 text-right text-[10px] leading-5 text-slate-500">
                                            {lineNumber ?? ""}
                                          </Text>
                                          <Text
                                            className={`text-[12px] leading-5 ${tone}`}
                                            style={{ fontFamily: MONO_FONT, fontWeight: "600" }}
                                          >
                                            {line.length > 0 ? line : " "}
                                          </Text>
                                        </View>
                                      ))}
                                    </View>
                                  </ScrollView>
                                )}
                              </>
                            );
                          })()}
                        </View>
                      ) : null}
                    </View>
                  )})}
                </View>
              ) : (
              item.kind === "activity" && item.activity ? (
                (() => {
                  if (item.activity.title === "Terminal output" && item.activity.detail) {
                    return (
                      <Pressable
                        className="w-full rounded-xl border border-border/20 bg-black/35 px-3 py-2"
                        onPress={() => {
                          setExpandedTerminalIds((existing) => {
                            const next = new Set(existing);
                            if (next.has(item.id)) {
                              next.delete(item.id);
                            } else {
                              next.add(item.id);
                            }
                            return next;
                          });
                        }}
                      >
                        <View className="flex-row items-center justify-between">
                          <Text className="text-xs font-semibold uppercase tracking-[0.8px] text-muted-foreground">
                            Terminal Output
                          </Text>
                          <Ionicons
                            name={expandedTerminalIds.has(item.id) ? "chevron-up" : "chevron-down"}
                            size={14}
                            color="#94a3b8"
                          />
                        </View>
                        {expandedTerminalIds.has(item.id) ? (
                          <Text className="mt-1 font-mono text-[12px] leading-5 text-foreground">
                            {item.activity.detail}
                          </Text>
                        ) : (
                          <Text className="mt-1 text-[12px] text-muted-foreground" numberOfLines={1}>
                            {(item.activity.detail.split("\n").find((line) => line.trim().length > 0) ?? "Tap to expand").trim()}
                          </Text>
                        )}
                      </Pressable>
                    );
                  }

                  if (
                    (item.activity.title === "Reasoning" ||
                      item.activity.title === "Plan" ||
                      item.activity.title === "File changes" ||
                      item.activity.title === "Tool progress" ||
                      item.activity.title.startsWith("Web search"))
                  ) {
                    const webSearchFallback =
                      item.activity.title.startsWith("Web search") && !item.activity.detail
                        ? resolveWebSearchFallback(index)
                        : null;
                    const activityDetail =
                      item.activity.title === "Reasoning"
                        ? formatReasoningDetail(item.activity.detail ?? "")
                        : item.activity.detail ?? (webSearchFallback ? `From prompt: ${webSearchFallback}` : "");
                    if (!activityDetail) {
                      return (
                        <View className="w-full py-1">
                          <Text className="text-center text-base font-medium text-muted-foreground">{item.activity.title}</Text>
                        </View>
                      );
                    }
                    return (
                      <View className="w-full rounded-xl border border-border/20 bg-black/35 px-3 py-2">
                        <Text className="mb-1 text-xs font-semibold uppercase tracking-[0.8px] text-muted-foreground">
                          {item.activity.title}
                        </Text>
                        <Text
                          className={`text-[12px] leading-5 text-foreground ${
                            item.activity.title === "File changes" ? "font-mono" : ""
                          }`}
                        >
                          {activityDetail}
                        </Text>
                      </View>
                    );
                  }

                  if (item.activity.title === "Ran command" && item.activity.detail) {
                    return (
                      <Pressable
                        className="w-full py-1"
                        onPress={() => {
                          setExpandedActivityIds((existing) => {
                            const next = new Set(existing);
                            if (next.has(item.id)) {
                              next.delete(item.id);
                            } else {
                              next.add(item.id);
                            }
                            return next;
                          });
                        }}
                      >
                        <Text className="text-center text-base font-medium text-muted-foreground">{item.activity.title}</Text>
                        {expandedActivityIds.has(item.id) ? (
                          <View className="mt-1 rounded-lg border border-border/20 bg-black/35 px-3 py-2">
                            <Text className="font-mono text-[12px] leading-5 text-foreground">
                              {item.activity.detail}
                            </Text>
                          </View>
                        ) : (
                          <Text className="mt-0.5 text-center text-sm text-muted-foreground" numberOfLines={1}>
                            {item.activity.detail}
                          </Text>
                        )}
                      </Pressable>
                    );
                  }

                  const isReadFileActivity = item.activity.title.startsWith("Read ");
                  return (
                    <View className="w-full py-1">
                      <Text
                        className={`${isReadFileActivity ? "text-left" : "text-center"} text-base font-medium text-muted-foreground`}
                      >
                        {item.activity.title}
                      </Text>
                      {item.activity.detail ? (
                        <Text
                          className={`mt-0.5 ${isReadFileActivity ? "text-left" : "text-center"} text-sm text-muted-foreground`}
                          numberOfLines={1}
                        >
                          {item.activity.detail}
                        </Text>
                      ) : null}
                    </View>
                  );
                })()
              ) : (
              item.role === "user" ? (
                <View className="mt-3 max-w-[86%]">
                  <View className="rounded-3xl border border-border/10 bg-neutral-500/40 px-4 py-2">
                    {item.text ? (
                      <Text selectable className="text-base leading-6 text-white">
                        {item.text}
                      </Text>
                    ) : null}
                    {item.images?.length ? (
                      <View className={item.text ? "mt-2" : ""}>
                        {item.images.map((uri, imageIndex) => (
                          <Pressable key={`${item.id}-user-image-${imageIndex}`} onPress={() => setPreviewImageUri(uri)}>
                            <Image
                              source={{ uri }}
                              resizeMode="contain"
                              className="mb-2 h-48 w-64 rounded-xl bg-black/25"
                            />
                          </Pressable>
                        ))}
                      </View>
                    ) : null}
                  </View>
                  {(() => {
                    const copyKey = copyGroupKeyForTurn(item);
                    const isLastSection = copyGroups.lastIndexByKey.get(copyKey) === index;
                    const copyText = copyGroups.textByKey.get(copyKey);
                    if (!isLastSection) {
                      return null;
                    }

                    return (
                      <View className="mt-1 flex-row justify-end">
                        <Pressable
                          onPress={() => copyTurnText(copyKey, copyText)}
                          disabled={!copyText}
                          className={`flex-row items-center gap-1 rounded-full px-2.5 py-1 ${
                            copyText ? "bg-black/20" : "bg-black/10"
                          }`}
                        >
                          <Ionicons
                            name={lastCopiedTurnId === copyKey ? "checkmark" : "copy-outline"}
                            size={12}
                            color={copyText ? "#dbeafe" : "#6b7280"}
                          />
                          <Text className={`text-xs ${copyText ? "text-blue-100" : "text-gray-500"}`}>
                            {lastCopiedTurnId === copyKey ? "Copied" : "Copy"}
                          </Text>
                        </Pressable>
                      </View>
                    );
                  })()}
                </View>
              ) : (
                <View className="w-full px-1 py-1">
                  {sanitizeAssistantDisplayText(item.text ?? "").length > 0 ? (
                    <Markdown style={markdownStyles} rules={selectableMarkdownRules}>
                      {sanitizeAssistantDisplayText(item.text ?? "")}
                    </Markdown>
                  ) : null}
                  {item.images?.length ? (
                    <View className={sanitizeAssistantDisplayText(item.text ?? "").length > 0 ? "mt-1" : ""}>
                      {item.images.map((uri, imageIndex) => (
                        <Pressable key={`${item.id}-assistant-image-${imageIndex}`} onPress={() => setPreviewImageUri(uri)}>
                          <Image
                            source={{ uri }}
                            resizeMode="contain"
                            className="mb-2 h-52 w-full rounded-xl bg-black/25"
                          />
                        </Pressable>
                      ))}
                    </View>
                  ) : null}
                  {(() => {
                    const copyKey = copyGroupKeyForTurn(item);
                    const isLastSection = copyGroups.lastIndexByKey.get(copyKey) === index;
                    const copyText = copyGroups.textByKey.get(copyKey);
                    if (!isLastSection) {
                      return null;
                    }

                    return (
                      <View className="mt-1 flex-row">
                        <Pressable
                          onPress={() => copyTurnText(copyKey, copyText)}
                          disabled={!copyText}
                          className={`flex-row items-center gap-1 rounded-full px-2.5 py-1 ${
                            copyText ? "bg-black/20" : "bg-black/10"
                          }`}
                        >
                          <Ionicons
                            name={lastCopiedTurnId === copyKey ? "checkmark" : "copy-outline"}
                            size={12}
                            color={copyText ? "#cbd5e1" : "#6b7280"}
                          />
                          <Text className={`text-xs ${copyText ? "text-slate-300" : "text-gray-500"}`}>
                            {lastCopiedTurnId === copyKey ? "Copied" : "Copy"}
                          </Text>
                        </Pressable>
                      </View>
                    );
                  })()}
                </View>
              )
              )
              )}
            </MotiView>
          )}
          ListEmptyComponent={
            loading ? (
              <View className="items-center justify-center rounded-2xl border border-border/10 bg-muted p-5">
                <ActivityIndicator color="#8f8f8f" />
                <Text className="mt-2 text-sm text-muted-foreground">Loading thread…</Text>
              </View>
            ) : (
              <View className="rounded-2xl border border-dashed border-border/50 bg-card p-4">
                <Text className="text-center text-sm text-muted-foreground">No turns available for this thread yet.</Text>
              </View>
            )
          }
          ListFooterComponent={
            <AnimatePresence>
              {smoothIsThinking ? <ThinkingShinyPill key="thinking" /> : null}
            </AnimatePresence>
          }
        />

        {showScrollToBottom ? (
          <Pressable
            onPress={scrollToBottom}
            className="absolute bottom-[158px] z-20 self-center rounded-full border border-border/10 bg-muted"
            style={{ width: 36, height: 36, justifyContent: "center", alignItems: "center" }}
          >
            <Ionicons name="arrow-down" size={16} color="#e0e0e0" />
          </Pressable>
        ) : null}

        {(() => {
          const composerContent = (
            <>
              {optionsLoaded && resolvedSelectedModel && currentReasoningOptions.length > 0 ? (
                <View className="mb-1.5 flex-row justify-between gap-2">
                  <View className="flex-row gap-2">
                    <Pressable
                      onPress={() => setOpenDropdown("model")}
                      className="h-9 flex gap-2 flex-row items-center justify-between rounded-full px-3"
                    >
                      <Text className="text-sm font-semibold text-foreground">
                        {modelOptions.find((option) => option.value === resolvedSelectedModel)?.label}
                      </Text>
                      <View className="w-4 items-center justify-center">
                        <Ionicons name="chevron-up" size={14} className="text-foreground" />
                      </View>
                    </Pressable>
                    <Pressable
                      onPress={() => setOpenDropdown("reasoning")}
                      className="h-9 flex gap-2 flex-row items-center justify-between rounded-full px-3"
                    >
                      <Text className="text-sm font-semibold text-foreground">
                        {currentReasoningOptions.find((option) => option.value === resolvedSelectedReasoning)?.label}
                      </Text>
                      <View className="w-4 items-center justify-center">
                        <Ionicons name="chevron-up" size={14} className="text-foreground" />
                      </View>
                    </Pressable>
                  </View>
                  {keyboardVisible ? (
                    <MotiView
                      from={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.8 }}
                      transition={{ type: "timing", duration: 150 }}
                    >
                      <Pressable
                        onPress={() => Keyboard.dismiss()}
                        className="h-9 flex-row items-center justify-center gap-1.5 rounded-full border border-border/10 bg-muted px-3"
                      >
                        <Ionicons name="keypad" size={16} color="#e0e0e0" />
                        <Ionicons name="chevron-down" className="pt-0.5" size={14} color="#e0e0e0" />
                      </Pressable>
                    </MotiView>
                  ) : null}
                </View>
              ) : null}

              {showMentionSuggestions ? (
                <View className="mb-2 max-h-56 overflow-hidden rounded-2xl border border-border/10 bg-muted">
                  <View className="flex-row items-center gap-1.5 border-b border-border/10 px-3 py-1.5">
                    <Ionicons name="at" size={13} color="#94a3b8" />
                    <Text className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                      Files
                    </Text>
                    {mentionLoading ? (
                      <ActivityIndicator size="small" color="#94a3b8" className="ml-auto" />
                    ) : null}
                  </View>
                  {mentionError ? (
                    <View className="flex-row items-center gap-2 px-3 py-2.5">
                      <Ionicons name="warning-outline" size={14} color="#fbbf24" />
                      <Text className="text-xs text-amber-300">{mentionError}</Text>
                    </View>
                  ) : null}
                  {mentionLoading && mentionSuggestions.length === 0 ? (
                    <View className="px-3 py-3">
                      <Text className="text-xs text-muted-foreground">Searching files…</Text>
                    </View>
                  ) : null}
                  {!mentionLoading && !mentionError && mentionSuggestions.length === 0 ? (
                    <View className="flex-row items-center gap-2 px-3 py-3">
                      <Ionicons name="document-outline" size={14} color="#64748b" />
                      <Text className="text-xs text-muted-foreground">No matching files</Text>
                    </View>
                  ) : null}
                  <ScrollView
                    nestedScrollEnabled
                    keyboardShouldPersistTaps="handled"
                    showsVerticalScrollIndicator
                    className="max-h-44"
                  >
                    {mentionSuggestions.map((filePath) => {
                      const parts = filePath.split("/");
                      const fileName = parts.pop() ?? filePath;
                      const dirPath = parts.join("/");
                      return (
                        <Pressable
                          key={`mention-${filePath}`}
                          onPress={() => applyMentionSelection(filePath)}
                          className="flex-row items-center gap-2.5 border-b border-border/5 px-3 py-2 active:bg-white/5"
                        >
                          <Ionicons name="document-text-outline" size={16} color="#94a3b8" />
                          <View className="flex-1">
                            <Text className="font-mono text-[13px] font-semibold text-foreground" numberOfLines={1}>
                              {fileName}
                            </Text>
                            {dirPath ? (
                              <Text className="font-mono text-[11px] text-muted-foreground" numberOfLines={1}>
                                {dirPath}
                              </Text>
                            ) : null}
                          </View>
                        </Pressable>
                      );
                    })}
                  </ScrollView>
                </View>
              ) : null}

              {pendingImages.length > 0 ? (
                <View className="mb-2">
                  <FlatList
                    horizontal
                    data={pendingImages}
                    keyExtractor={(item) => item.id}
                    showsHorizontalScrollIndicator={false}
                    renderItem={({ item }) => (
                      <View className="mr-2">
                        <Pressable onPress={() => setPreviewImageUri(item.uri)}>
                          <Image source={{ uri: item.uri }} resizeMode="cover" className="h-16 w-16 rounded-lg bg-black/25" />
                        </Pressable>
                        <Pressable
                          onPress={() =>
                            setPendingImages((existing) => existing.filter((image) => image.id !== item.id))
                          }
                          className="absolute -right-1 -top-1 rounded-full bg-black/70 p-1"
                        >
                          <Ionicons name="close" size={12} color="#ffffff" />
                        </Pressable>
                      </View>
                    )}
                  />
                </View>
              ) : null}

              <View className="flex-row items-end gap-2">
                <Pressable
                  onPress={onPickImages}
                  className="h-11 w-11 items-center justify-center rounded-full border border-border/10 bg-muted"
                >
                  <Ionicons name="image-outline" size={18} className="text-primary-foreground" />
                </Pressable>
                <TextInput
                  ref={composerInputRef}
                  value={composerText}
                  onChangeText={setComposerText}
                  onSelectionChange={(event) => setComposerSelection(event.nativeEvent.selection)}
                  selection={composerSelection}
                  placeholder="Continue this thread..."
                  placeholderTextColor="#94a3b8"
                  keyboardAppearance="dark"
                  multiline
                  className="max-h-36 flex-1 rounded-3xl border border-border/10 bg-muted px-4 py-3 text-foreground"
                />
                <Pressable
                  disabled={isResponding ? stopping || !activeTurnId : sending || !composerHasDraft}
                  onPress={isResponding ? onStopResponse : onSend}
                  className={`h-11 w-11 items-center justify-center rounded-full ${
                    isResponding || sending || !composerHasDraft ? "bg-secondary" : "bg-primary"
                  }`}
                >
                  <AnimatePresence>
                    <MotiView
                      key={`${composerActionIconName}-${isResponding ? "responding" : "idle"}-${stopping ? "stopping" : "active"}`}
                      from={{ opacity: 0, scale: 0.78, rotate: "-10deg" }}
                      animate={{ opacity: 1, scale: 1, rotate: "0deg" }}
                      exit={{ opacity: 0, scale: 0.78, rotate: "10deg" }}
                      transition={{ type: "timing", duration: 140 }}
                      style={{ width: 20, height: 20, alignItems: "center", justifyContent: "center" }}
                    >
                      <Ionicons name={composerActionIconName} size={20} className="text-primary-foreground" />
                    </MotiView>
                  </AnimatePresence>
                </Pressable>
              </View>
            </>
          );

          return Platform.OS === "android" ? (
            <KeyboardStickyView offset={{ closed: 0, opened: 0 }}>
              <View
                className="-mx-4 border-t border-border/50 bg-background px-4 pt-2"
                style={{ paddingBottom: Math.max(insets.bottom, 8) }}
              >
                {composerContent}
              </View>
            </KeyboardStickyView>
          ) : (
            <View
              className="-mx-4 border-t border-border/50 bg-background px-4 pt-2"
              style={{ paddingBottom: keyboardVisible ? 10 : Math.max(insets.bottom, 8) }}
            >
              {composerContent}
            </View>
          );
        })()}
      </View>
      </KeyboardAvoidingView>

      <Modal
        transparent
        visible={openDropdown !== null && optionsLoaded}
        animationType="fade"
        onRequestClose={() => setOpenDropdown(null)}
      >
        <Pressable
          className="flex-1 justify-end bg-background/80 px-4"
          style={{ paddingBottom: Math.max(insets.bottom, 8) + 96 }}
          onPress={() => setOpenDropdown(null)}
        >
          <AnimatePresence>
            {openDropdown !== null && (
              <MotiView
                from={{ opacity: 0, translateY: 100 }}
                animate={{ opacity: 1, translateY: 0 }}
                exit={{ opacity: 0, translateY: 100 }}
                transition={{ type: "timing", duration: 250 }}
              >
                <Pressable
                  className="rounded-xl border border-border/10 bg-muted p-2"
                  onPress={(event) => {
                    event.stopPropagation();
                  }}
                >
                  {(openDropdown === "model" ? modelOptions : currentReasoningOptions).map((option) => {
                    const isModel = openDropdown === "model";
                    const active = isModel ? resolvedSelectedModel === option.value : resolvedSelectedReasoning === option.value;
                    return (
                      <Pressable
                        key={`${openDropdown}-${option.label}`}
                        className={`rounded-lg px-3 py-3 flex-row items-center justify-between ${active ? "bg-card" : "bg-transparent"}`}
                        onPress={() => {
                          if (isModel) {
                            setSelectedModel(option.value as string);
                          } else {
                            setSelectedReasoning(option.value as ReasoningEffort);
                          }
                          setOpenDropdown(null);
                        }}
                      >
                        <Text className={`text-base ${active ? "font-semibold text-primary-foreground" : "text-muted-foreground"}`}>{option.label}</Text>
                        {active && (
                          <Ionicons name="checkmark" size={20} className="text-primary-foreground" />
                        )}
                      </Pressable>
                    );
                  })}
                </Pressable>
              </MotiView>
            )}
          </AnimatePresence>
        </Pressable>
      </Modal>

      <Modal
        transparent
        visible={previewImageUri !== null}
        animationType="fade"
        onRequestClose={() => setPreviewImageUri(null)}
      >
        <Pressable
          className="flex-1 bg-black/95 px-4"
          style={{
            paddingTop: Math.max(insets.top, 8) + 8,
            paddingBottom: Math.max(insets.bottom, 8) + 8,
          }}
          onPress={() => setPreviewImageUri(null)}
        >
          <View className="mb-3 flex-row justify-end">
            <View className="rounded-full bg-white/10 p-2">
              <Ionicons name="close" size={20} color="#ffffff" />
            </View>
          </View>
          <Pressable
            className="flex-1 items-center justify-center"
            onPress={(event) => {
              event.stopPropagation();
            }}
          >
            {previewImageUri ? (
              <Image source={{ uri: previewImageUri }} resizeMode="contain" className="h-full w-full" />
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}
