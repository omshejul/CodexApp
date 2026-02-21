import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import { useLocalSearchParams } from "expo-router";
import { router } from "expo-router";
import { MotiView } from "moti";
import { Ionicons } from "@expo/vector-icons";
import Markdown from "react-native-markdown-display";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import {
  ReauthRequiredError,
  clearSession,
  getGatewayOptions,
  getStreamConfig,
  getThread,
  getThreadEvents,
  resumeThread,
  sendThreadMessage,
} from "@/lib/api";
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

const markdownStyles = {
  body: {
    color: "#e6edf7",
    fontSize: 14,
    lineHeight: 21,
    fontFamily: SYSTEM_FONT,
  },
  heading1: { color: "#f5f8ff", fontSize: 22, marginTop: 10, marginBottom: 8, fontFamily: SYSTEM_FONT },
  heading2: { color: "#f5f8ff", fontSize: 19, marginTop: 8, marginBottom: 6, fontFamily: SYSTEM_FONT },
  heading3: { color: "#f5f8ff", fontSize: 17, marginTop: 6, marginBottom: 4, fontFamily: SYSTEM_FONT },
  paragraph: { marginTop: 0, marginBottom: 8 },
  bullet_list: { marginTop: 0, marginBottom: 8 },
  ordered_list: { marginTop: 0, marginBottom: 8 },
  list_item: { marginBottom: 4 },
  ordered_list_content: { flex: 1, flexShrink: 1 },
  bullet_list_content: { flex: 1, flexShrink: 1 },
  code_inline: {
    backgroundColor: "#1f293b",
    color: "#d4e6ff",
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    fontFamily: SYSTEM_FONT,
  },
  code_block: {
    backgroundColor: "#0a1220",
    color: "#d4e6ff",
    borderRadius: 10,
    padding: 10,
    marginTop: 4,
    marginBottom: 10,
    fontFamily: SYSTEM_FONT,
  },
  fence: {
    backgroundColor: "#0a1220",
    color: "#d4e6ff",
    borderRadius: 10,
    padding: 10,
    marginTop: 4,
    marginBottom: 10,
    fontFamily: SYSTEM_FONT,
  },
  blockquote: {
    backgroundColor: "#0f1a2c",
    borderLeftWidth: 3,
    borderLeftColor: "#3a80d9",
    color: "#bfd7f6",
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  hr: { backgroundColor: "#203552", marginVertical: 12 },
  strong: { color: "#f7fbff" },
  em: { color: "#d4e6ff" },
  link: { color: "#6eb5ff" },
};

const userMarkdownStyles = {
  ...markdownStyles,
  body: {
    color: "#f8fbff",
    fontSize: 14,
    lineHeight: 21,
    fontFamily: SYSTEM_FONT,
  },
  heading1: { color: "#ffffff", fontSize: 22, marginTop: 10, marginBottom: 8, fontFamily: SYSTEM_FONT },
  heading2: { color: "#ffffff", fontSize: 19, marginTop: 8, marginBottom: 6, fontFamily: SYSTEM_FONT },
  heading3: { color: "#ffffff", fontSize: 17, marginTop: 6, marginBottom: 4, fontFamily: SYSTEM_FONT },
  code_inline: {
    backgroundColor: "#2a6bc0",
    color: "#eff7ff",
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    fontFamily: SYSTEM_FONT,
  },
  code_block: {
    backgroundColor: "#2059a8",
    color: "#eff7ff",
    borderRadius: 10,
    padding: 10,
    marginTop: 4,
    marginBottom: 10,
    fontFamily: SYSTEM_FONT,
  },
  fence: {
    backgroundColor: "#2059a8",
    color: "#eff7ff",
    borderRadius: 10,
    padding: 10,
    marginTop: 4,
    marginBottom: 10,
    fontFamily: SYSTEM_FONT,
  },
  link: { color: "#d6ebff" },
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

function turnsSignature(items: RenderedTurn[]): string {
  return items.map((item) => `${item.id}:${item.role}:${item.kind ?? "message"}:${item.text.length}`).join("|");
}

function turnContentSignature(item: RenderedTurn): string {
  if (item.kind === "changeSummary" && item.summary) {
    const files = item.summary.files
      .map(
        (file) =>
          `${file.path}:${file.additions}:${file.deletions}:${file.diff?.length ?? 0}:${(file.snippets ?? []).join("|")}`
      )
      .join(";");
    return `change:${files}`;
  }
  if (item.kind === "activity" && item.activity) {
    return `activity:${item.activity.title}:${item.activity.detail ?? ""}`;
  }
  return `msg:${item.role}:${item.text}`;
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
  if (!lower.includes("diff") && !lower.includes("filechange") && !lower.includes("file_change")) {
    return null;
  }

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

  if (!files.length) {
    return null;
  }

  return {
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
    const responseId = `raw-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

    if (type === "web_search_call") {
      const action = responseItem.action && typeof responseItem.action === "object" ? (responseItem.action as Record<string, unknown>) : null;
      const queries = action && Array.isArray(action.queries) ? action.queries : [];
      const query =
        (action && typeof action.query === "string" && action.query.trim()) ||
        (queries[0] && typeof queries[0] === "string" ? queries[0] : "");
      return {
        id: responseId,
        role: "system",
        text: "",
        kind: "activity",
        activity: {
          title: query ? `Searched web for ${query}` : "Searched web",
        },
      };
    }

    if (type === "local_shell_call") {
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

    if (type === "compaction") {
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

  if (lower !== "item/completed" && lower !== "item/started") {
    return null;
  }

  if (!params || typeof params !== "object") {
    return null;
  }

  const record = params as Record<string, unknown>;
  const item = record.item;
  if (!item || typeof item !== "object") {
    return null;
  }

  const threadItem = item as Record<string, unknown>;
  const itemType = typeof threadItem.type === "string" ? threadItem.type : "";
  const itemId = typeof threadItem.id === "string" ? threadItem.id : `${Date.now()}`;

  if (itemType === "contextCompaction") {
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

  if (itemType === "commandExecution") {
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

  if (itemType === "webSearch") {
    const query = typeof threadItem.query === "string" ? threadItem.query.trim() : "";
    return {
      id: `activity-${itemId}`,
      role: "system",
      text: "",
      kind: "activity",
      activity: {
        title: query ? `Searched web for ${query}` : "Searched web",
      },
    };
  }

  return null;
}

function toPersistedEventTurns(
  events: Array<{ id: number; method: string; params?: unknown }>,
  existing: RenderedTurn[]
): RenderedTurn[] {
  const merged = [...existing];
  const seen = new Set(merged.map((item) => turnContentSignature(item)));

  for (const event of events) {
    const summary = extractChangeSummaryFromEvent(event.method, event.params ?? null);
    if (summary) {
      const candidate: RenderedTurn = {
        id: `persisted-change-${event.id}`,
        role: "system",
        text: "",
        kind: "changeSummary",
        summary,
      };
      const signature = turnContentSignature(candidate);
      if (!seen.has(signature)) {
        seen.add(signature);
        merged.push(candidate);
      }
      continue;
    }

    const activity = extractActivityFromEvent(event.method, event.params ?? null);
    if (activity) {
      const candidate: RenderedTurn = {
        ...activity,
        id: `persisted-activity-${event.id}`,
      };
      const signature = turnContentSignature(candidate);
      if (!seen.has(signature)) {
        seen.add(signature);
        merged.push(candidate);
      }
    }
  }

  return merged;
}

function ThinkingShinyPill() {
  return (
    <View className="pb-1 pt-2">
      <View className="relative self-start overflow-hidden rounded-full border border-emerald-300/30 bg-emerald-950/45 px-4 py-2">
        <MotiView
          from={{ translateX: -140, opacity: 0.1 }}
          animate={{ translateX: 220, opacity: 0.45 }}
          transition={{ type: "timing", duration: 1700, loop: true, repeatReverse: false }}
          className="absolute -bottom-8 -top-8 w-14 bg-white/25"
          style={{
            transform: [{ rotate: "18deg" }],
          }}
        />
        <View className="relative flex-row items-center gap-2">
          <Ionicons name="sparkles-outline" size={14} color="#b7f7d0" />
          <Text className="text-sm font-semibold text-emerald-100">Thinking</Text>
          <MotiView
            from={{ opacity: 0.35, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ type: "timing", duration: 650, loop: true, repeatReverse: true }}
            className="h-1.5 w-1.5 rounded-full bg-emerald-300"
          />
        </View>
      </View>
    </View>
  );
}

export default function ThreadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const threadId = useMemo(() => (Array.isArray(id) ? id[0] : id), [id]);
  const insets = useSafeAreaInsets();

  const [turns, setTurns] = useState<RenderedTurn[]>([]);
  const [composerText, setComposerText] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamingAssistant, setStreamingAssistant] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [selectedReasoning, setSelectedReasoning] = useState<ReasoningEffort | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [expandedActivityIds, setExpandedActivityIds] = useState<Set<string>>(new Set());
  const [streamStatus, setStreamStatus] = useState<{ tone: StreamStatusTone; text: string }>({
    tone: "warn",
    text: "Connecting",
  });
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [reasoningOptionsByModel, setReasoningOptionsByModel] = useState<Record<string, ReasoningOption[]>>({});
  const [optionsLoaded, setOptionsLoaded] = useState(false);
  const [openDropdown, setOpenDropdown] = useState<OpenDropdown>(null);

  const streamSocketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const optionsRefreshPromiseRef = useRef<Promise<void> | null>(null);
  const selectedModelRef = useRef<string | null>(null);
  const listRef = useRef<FlatList<RenderedTurn>>(null);
  const followBottomRef = useRef(true);
  const draggingRef = useRef(false);
  const initialSnapDoneRef = useRef(false);
  const seenEventIdsRef = useRef(new Set<string>());
  const seenChangeHashesRef = useRef(new Set<string>());
  const turnsSignatureRef = useRef("");

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
    setIsThinking(false);
    setTurns([]);
    setExpandedActivityIds(new Set());
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
            const key = JSON.stringify(summary);
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

          if (method.includes("delta")) {
            const delta = extractDeltaText(payload.params);
            if (delta) {
              setStreamingAssistant((existing) => `${existing}${delta}`);
            }
            return;
          }

          if (method.includes("complete") || method.includes("done") || method.includes("turn/end")) {
            setIsThinking(false);
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
        const [thread, eventsResponse] = await Promise.all([getThread(threadId), getThreadEvents(threadId)]);
        if (!active) {
          return;
        }

        const initialTurns = toRenderedTurns(thread.turns);
        const withPersistedEvents = toPersistedEventTurns(eventsResponse.events, initialTurns);
        setTurns(withPersistedEvents);
        setError(null);
        turnsSignatureRef.current = turnsSignature(withPersistedEvents);
        seenChangeHashesRef.current = new Set(
          withPersistedEvents
            .filter((item) => item.kind === "changeSummary" && item.summary)
            .map((item) => JSON.stringify(item.summary))
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
  }, [threadId]);

  useEffect(() => {
    if (!threadId) {
      return;
    }
    if (loading) {
      return;
    }

    const shouldSync = isThinking || streamStatus.tone !== "ok";
    if (!shouldSync) {
      return;
    }

    let active = true;
    const timer = setInterval(async () => {
      try {
        const thread = await getThread(threadId);
        if (!active) {
          return;
        }
        const rendered = toRenderedTurns(thread.turns);
        const nextSignature = turnsSignature(rendered);
        if (nextSignature !== turnsSignatureRef.current) {
          turnsSignatureRef.current = nextSignature;
          setStreamingAssistant("");
          setTurns(rendered);
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
  }, [threadId, loading, isThinking, streamStatus.tone, markConnectionRecovered]);

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
  }, [turns, streamingAssistant]);

  const onListScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceFromBottom = contentSize.height - (contentOffset.y + layoutMeasurement.height);
    const isNearBottom = distanceFromBottom < 120;
    if (draggingRef.current) {
      followBottomRef.current = isNearBottom;
    }
    setShowScrollToBottom(!isNearBottom);
  };

  const scrollToBottom = () => {
    followBottomRef.current = true;
    setShowScrollToBottom(false);
    keepToBottom(true);
  };

  const onSend = async () => {
    if (!threadId || !composerText.trim() || sending) {
      return;
    }

    Keyboard.dismiss();
    const text = composerText.trim();
    setComposerText("");
    setSending(true);
    setError(null);

    setTurns((existing) => [
      ...existing,
      {
        id: `local-user-${Date.now()}`,
        role: "user",
        text,
      },
    ]);
    followBottomRef.current = true;

    try {
      await sendThreadMessage(threadId, {
        text,
        model: resolvedSelectedModel ?? undefined,
        reasoningEffort: resolvedSelectedReasoning ?? undefined,
      });
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

  const allTurns = streamingAssistant
    ? [
        ...turns,
        {
          id: "live-assistant",
          role: "assistant" as const,
          text: streamingAssistant,
          streaming: true,
        },
      ]
    : turns;

  return (
    <SafeAreaView className="flex-1 bg-background" edges={["top", "left", "right"]}>
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={0}
      >
      <View className="flex-1 bg-background px-4 pt-1">
      <View className="-mx-4 mb-3 flex-row items-center border-b border-border/50 pb-2 px-4">
      <View className="w-28">
            <Pressable
              onPress={() => router.back()}
              className="self-start h-10 w-10 items-center justify-center"
            >
              <Ionicons name="chevron-back" size={24} color="#ffffff" />
            </Pressable>
          </View>
          <View className="flex-1 items-center">
            <Text className="text-3xl font-semibold text-foreground">Chat</Text>
          </View>
          <View className="w-28 items-end">
            <View className="flex-row items-center rounded-full border border-border/10 bg-card px-3 py-1.5">
              <View className="mr-2 h-2.5 w-2.5 rounded-full" style={{ backgroundColor: streamDotColor }} />
              <Text className="text-xs font-semibold text-foreground">{streamStatus.text}</Text>
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
                  <Text className="text-3xl font-bold text-card-foreground">
                    {item.summary.filesChanged} file{item.summary.filesChanged === 1 ? "" : "s"} changed
                  </Text>
                  {item.summary.files.map((file) => (
                    <View key={`${item.id}-${file.path}`} className="mt-3">
                      <View className="flex-row items-center justify-between">
                        <Text className="max-w-[70%] text-2xl text-foreground" numberOfLines={1}>
                          {file.path}
                        </Text>
                        <Text className="text-2xl font-semibold">
                          <Text className="text-emerald-400">+{file.additions}</Text>
                          <Text className="text-red-400"> -{file.deletions}</Text>
                        </Text>
                      </View>
                      {typeof file.diff === "string" && file.diff.length > 0 ? (
                        <View className="mt-2 rounded-lg border border-border/40 bg-muted/60 px-2.5 py-2">
                          <Text className="font-mono text-[11px] leading-4 text-muted-foreground">{file.diff}</Text>
                        </View>
                      ) : null}
                    </View>
                  ))}
                </View>
              ) : (
              item.kind === "activity" && item.activity ? (
                item.activity.title === "Ran command" && item.activity.detail ? (
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
                      <Text className="mt-0.5 text-center text-sm text-muted-foreground">
                        {item.activity.detail}
                      </Text>
                    ) : (
                      <Text className="mt-0.5 text-center text-sm text-muted-foreground" numberOfLines={1}>
                        {item.activity.detail}
                      </Text>
                    )}
                  </Pressable>
                ) : (
                  <View className="w-full py-1">
                    <Text className="text-center text-base font-medium text-muted-foreground">{item.activity.title}</Text>
                    {item.activity.detail ? (
                      <Text className="mt-0.5 text-center text-sm text-muted-foreground" numberOfLines={1}>
                        {item.activity.detail}
                      </Text>
                    ) : null}
                  </View>
                )
              ) : (
              item.role === "user" ? (
                <View className="max-w-[86%] rounded-2xl border border-border/10 bg-neutral-500/40 px-4 py-2 mt-3">
                  <Text className="text-base leading-6 text-white">{item.text}</Text>
                </View>
              ) : (
                <View className="w-full px-1 py-1">
                  <Markdown style={markdownStyles}>{item.text}</Markdown>
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
            isThinking ? (
              <ThinkingShinyPill />
            ) : null
          }
        />

        {showScrollToBottom ? (
          <Pressable
            onPress={scrollToBottom}
            className="absolute bottom-[188px] right-4 z-20 rounded-full border border-border/10 bg-muted px-2.5 py-2"
          >
            <Ionicons name="arrow-down" size={16} color="#e0e0e0" />
          </Pressable>
        ) : null}

        <View
          className="-mx-4 border-t border-border/50 bg-background px-4 pt-2"
          style={{
            paddingBottom: Math.max(insets.bottom, 8),
          }}
        >
          {keyboardVisible ? (
            <View className="mb-2 flex-row justify-end">
              <Pressable
                onPress={() => Keyboard.dismiss()}
                className="rounded-full border border-border/10 bg-muted px-3 py-1.5"
              >
                <Text className="text-xs font-semibold text-foreground">Hide Keyboard</Text>
              </Pressable>
            </View>
          ) : null}
          {optionsLoaded && resolvedSelectedModel && currentReasoningOptions.length > 0 ? (
            <View className="mb-2 flex-row gap-2">
              <Pressable
                onPress={() => setOpenDropdown("model")}
                className="h-9 flex-1 flex-row items-center justify-between rounded-full border border-border/10 bg-muted px-3"
              >
                <Text className="text-sm font-semibold text-foreground">
                  {modelOptions.find((option) => option.value === resolvedSelectedModel)?.label}
                </Text>
                <Text className="text-sm font-semibold text-emerald-300">^</Text>
              </Pressable>
              <Pressable
                onPress={() => setOpenDropdown("reasoning")}
                className="h-9 flex-1 flex-row items-center justify-between rounded-full border border-border/10 bg-muted px-3"
              >
                <Text className="text-sm font-semibold text-foreground">
                  {currentReasoningOptions.find((option) => option.value === resolvedSelectedReasoning)?.label}
                </Text>
                <Text className="text-sm font-semibold text-emerald-300">^</Text>
              </Pressable>
            </View>
          ) : null}

          <View className="flex-row items-end gap-2">
            <TextInput
              value={composerText}
              onChangeText={setComposerText}
              placeholder="Continue this thread..."
              placeholderTextColor="#6f6f6f"
              multiline
              className="max-h-36 flex-1 rounded-full border border-border/10 bg-muted px-4 py-3 text-sm text-foreground"
            />
            <Pressable
              disabled={sending || !composerText.trim()}
              onPress={onSend}
              className={`min-w-[92px] rounded-2xl px-4 py-3 ${
                sending || !composerText.trim() ? "bg-secondary" : "bg-primary"
              }`}
            >
              <View className="flex-row items-center justify-center gap-2">
                <Ionicons name={sending ? "time-outline" : "send"} size={14} color="#d8ffd8" />
                <Text className="text-center text-sm font-bold text-primary-foreground">{sending ? "..." : "Send"}</Text>
              </View>
            </Pressable>
          </View>
        </View>
      </View>
      </KeyboardAvoidingView>

      <Modal
        transparent
        visible={openDropdown !== null && optionsLoaded}
        animationType="fade"
        onRequestClose={() => setOpenDropdown(null)}
      >
        <Pressable className="flex-1 bg-background/80 px-4 pt-24" onPress={() => setOpenDropdown(null)}>
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
                  className={`rounded-lg px-3 py-3 ${active ? "bg-primary/30" : "bg-transparent"}`}
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
                </Pressable>
              );
            })}
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}
