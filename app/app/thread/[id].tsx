import { useEffect, useMemo, useRef, useState } from "react";
import {
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
import EventSource from "react-native-sse";
import Markdown from "react-native-markdown-display";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import {
  ReauthRequiredError,
  clearSession,
  getGatewayOptions,
  getStreamConfig,
  getThread,
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
  value: string | null;
}

interface ReasoningOption {
  label: string;
  value: ReasoningEffort | null;
}

const DEFAULT_REASONING_OPTIONS: ReasoningOption[] = [
  { label: "Auto", value: null },
  { label: "Minimal", value: "minimal" },
  { label: "Low", value: "low" },
  { label: "Medium", value: "medium" },
  { label: "High", value: "high" },
];

type OpenDropdown = "model" | "reasoning" | null;

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

function extractChangeSummaryFromEvent(method: string, params: unknown): RenderedTurn["summary"] | null {
  const lower = method.toLowerCase();
  if (!lower.includes("diff") && !lower.includes("filechange") && !lower.includes("file_change")) {
    return null;
  }

  const files: Array<{ path: string; additions: number; deletions: number }> = [];
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

    if (
      typeof pathValue === "string" &&
      typeof additionsValue === "number" &&
      typeof deletionsValue === "number" &&
      Number.isFinite(additionsValue) &&
      Number.isFinite(deletionsValue)
    ) {
      const key = `${pathValue}:${additionsValue}:${deletionsValue}`;
      if (!seen.has(key)) {
        seen.add(key);
        files.push({
          path: pathValue,
          additions: additionsValue,
          deletions: deletionsValue,
        });
      }
    }

    const diffText = typeof record.diff === "string" ? record.diff : typeof record.delta === "string" ? record.delta : null;
    if (diffText && diffText.includes("diff --git")) {
      const perFile = new Map<string, { additions: number; deletions: number }>();
      let currentPath: string | null = null;
      for (const line of diffText.split("\n")) {
        const header = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
        if (header) {
          currentPath = header[2] || header[1];
          if (!perFile.has(currentPath)) {
            perFile.set(currentPath, { additions: 0, deletions: 0 });
          }
          continue;
        }
        if (!currentPath) {
          continue;
        }
        if (line.startsWith("+++ ") || line.startsWith("--- ")) {
          continue;
        }
        if (line.startsWith("+")) {
          const stat = perFile.get(currentPath);
          if (stat) {
            stat.additions += 1;
          }
          continue;
        }
        if (line.startsWith("-")) {
          const stat = perFile.get(currentPath);
          if (stat) {
            stat.deletions += 1;
          }
        }
      }

      for (const [path, stat] of perFile.entries()) {
        const key = `${path}:${stat.additions}:${stat.deletions}`;
        if (!seen.has(key)) {
          seen.add(key);
          files.push({ path, additions: stat.additions, deletions: stat.deletions });
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
          detail: command ? command.slice(0, 140) : undefined,
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
        detail: command.slice(0, 140),
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
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([{ label: "Auto", value: null }]);
  const [reasoningOptionsByModel, setReasoningOptionsByModel] = useState<Record<string, ReasoningOption[]>>({});
  const [openDropdown, setOpenDropdown] = useState<OpenDropdown>(null);

  const eventSourceRef = useRef<EventSource | null>(null);
  const listRef = useRef<FlatList<RenderedTurn>>(null);
  const followBottomRef = useRef(true);
  const draggingRef = useRef(false);
  const seenEventIdsRef = useRef(new Set<string>());
  const seenChangeHashesRef = useRef(new Set<string>());

  const currentReasoningOptions = useMemo(() => {
    if (!selectedModel) {
      return DEFAULT_REASONING_OPTIONS;
    }
    return reasoningOptionsByModel[selectedModel] ?? DEFAULT_REASONING_OPTIONS;
  }, [reasoningOptionsByModel, selectedModel]);

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
    if (!threadId) {
      return;
    }

    let active = true;

    const setup = async () => {
      setError(null);
      setLoading(true);

      try {
        await resumeThread(threadId);
        const thread = await getThread(threadId);
        if (!active) {
          return;
        }

        setTurns(toRenderedTurns(thread.turns));

        const stream = await getStreamConfig(threadId);
        if (!active) {
          return;
        }

        const eventSource = new EventSource(stream.url, {
          headers: {
            Authorization: `Bearer ${stream.token}`,
          },
          pollingInterval: 0,
        });

        eventSource.addEventListener("codex" as never, (event) => {
          const data = (event as { data?: string }).data;
          if (!data) {
            return;
          }

          const payload = parseSsePayload(data);
          if (!payload) {
            return;
          }

          const method = payload.method.toLowerCase();

          if (
            method === "turn/started" ||
            method === "item/started" ||
            method.includes("reasoning") ||
            method.includes("plan/")
            ) {
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
        });

        eventSource.addEventListener("error", () => {
          setError("Stream disconnected. Pull to refresh thread history.");
        });

        eventSourceRef.current = eventSource;
      } catch (setupError) {
        if (setupError instanceof ReauthRequiredError) {
          await clearSession();
          router.replace("/pair");
          return;
        }
        setError(setupError instanceof Error ? setupError.message : "Unable to load thread");
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    setup().catch(() => {
      setError("Unable to load thread");
      setLoading(false);
    });

    return () => {
      active = false;
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    };
  }, [threadId]);

  useEffect(() => {
    let active = true;

    const loadOptions = async () => {
      try {
        const payload = await getGatewayOptions();
        if (!active) {
          return;
        }

        const nextModelOptions: ModelOption[] = [{ label: "Auto", value: null }];
        const nextReasoningByModel: Record<string, ReasoningOption[]> = {};

        for (const model of payload.models) {
          nextModelOptions.push({
            label: model.label,
            value: model.model,
          });

          const modelReasoningOptions: ReasoningOption[] = [{ label: "Auto", value: null }];
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

          if (modelReasoningOptions.length === 1) {
            modelReasoningOptions.push(...DEFAULT_REASONING_OPTIONS.filter((opt) => opt.value !== null));
          }

          nextReasoningByModel[model.model] = modelReasoningOptions;
        }

        setModelOptions(nextModelOptions);
        setReasoningOptionsByModel(nextReasoningByModel);

        if (payload.defaultModel && nextModelOptions.some((model) => model.value === payload.defaultModel)) {
          setSelectedModel(payload.defaultModel);
        }

        if (payload.defaultReasoningEffort && payload.defaultReasoningEffort !== "none") {
          setSelectedReasoning(payload.defaultReasoningEffort);
        }
      } catch {
        // fall back to static options if model/list is unavailable
      }
    };

    loadOptions().catch(() => {
      // ignore, fallback options remain active
    });

    return () => {
      active = false;
    };
  }, []);

  const keepToBottom = (animated: boolean) => {
    listRef.current?.scrollToEnd({ animated });
    // Layout/stream deltas can continue arriving after the first scroll.
    setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 80);
    setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 220);
  };

  useEffect(() => {
    if (!followBottomRef.current) {
      return;
    }
    const timer = setTimeout(() => {
      keepToBottom(true);
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
        model: selectedModel ?? undefined,
        reasoningEffort: selectedReasoning ?? undefined,
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
    <SafeAreaView className="flex-1 bg-[#090f1a]" edges={["top", "left", "right", "bottom"]}>
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={0}
      >
      <View className="flex-1 bg-[#090f1a] px-4 pt-1">
        <View className="mb-3 flex-row items-center justify-between">
          <Pressable
            onPress={() => router.back()}
            className="rounded-full border border-[#244068] bg-[#101b2d] px-4 py-2"
          >
            <Text className="text-sm font-semibold text-[#d8e8ff]">‹ Threads</Text>
          </Pressable>
          <Text className="text-4xl font-bold text-[#d8e8ff]">Thread</Text>
          <View className="w-[82px]" />
        </View>
        <Text className="mb-2 text-[11px] font-semibold uppercase tracking-[1.2px] text-[#5d7598]">Thread</Text>
        <Text className="mb-3 rounded-xl border border-[#1f2d44] bg-[#0d1628] px-3 py-2 text-xs text-[#8fb4e2]">{threadId}</Text>

        {error ? (
          <View className="mb-3 rounded-xl border border-[#66313d] bg-[#2c141b] p-3">
            <Text className="text-sm text-[#ffc5d2]">{error}</Text>
          </View>
        ) : null}

        <FlatList
          ref={listRef}
          data={allTurns}
          keyExtractor={(item) => item.id}
          className="flex-1"
          contentContainerStyle={{ paddingBottom: 16 }}
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
              keepToBottom(false);
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
                <View className="w-full rounded-2xl border border-[#232a36] bg-[#18181b] px-4 py-4">
                  <Text className="text-3xl font-bold text-[#f5f5f5]">{item.summary.filesChanged} file changed</Text>
                  {item.summary.files.map((file) => (
                    <View key={`${item.id}-${file.path}`} className="mt-3 flex-row items-center justify-between">
                      <Text className="max-w-[70%] text-2xl text-[#f5f5f5]" numberOfLines={1}>
                        {file.path}
                      </Text>
                      <Text className="text-2xl font-semibold">
                        <Text className="text-[#4ade80]">+{file.additions}</Text>
                        <Text className="text-[#f87171]"> -{file.deletions}</Text>
                      </Text>
                    </View>
                  ))}
                </View>
              ) : (
              item.kind === "activity" && item.activity ? (
                <View className="w-full py-1">
                  <Text className="text-center text-base font-medium text-[#8b94a8]">{item.activity.title}</Text>
                  {item.activity.detail ? (
                    <Text className="mt-0.5 text-center text-sm text-[#6f7891]" numberOfLines={1}>
                      {item.activity.detail}
                    </Text>
                  ) : null}
                </View>
              ) : (
              <View
                className={`max-w-[86%] rounded-2xl px-3 py-3 ${
                  item.role === "user"
                    ? "border border-[#2d6cc3] bg-[#2356a0]"
                    : item.streaming
                    ? "border border-[#284165] bg-[#0f1a2d]"
                    : "border border-[#1d2b42] bg-[#0f1729]"
                }`}
              >
                {item.role === "user" ? (
                  <Text className="text-sm leading-6 text-[#f8fbff]">{item.text}</Text>
                ) : (
                  <Markdown style={markdownStyles}>{item.text}</Markdown>
                )}
              </View>
              )
              )}
            </MotiView>
          )}
          ListEmptyComponent={
            !loading ? (
              <View className="rounded-2xl border border-dashed border-[#2a3c59] bg-[#0d1628] p-4">
                <Text className="text-center text-sm text-[#85a7d1]">No turns available for this thread yet.</Text>
              </View>
            ) : null
          }
          ListFooterComponent={
            isThinking ? (
              <View className="pb-1 pt-1">
                <Text className="text-left text-2xl font-medium text-[#9aa3b2]">Thinking</Text>
              </View>
            ) : null
          }
        />

        {showScrollToBottom ? (
          <Pressable
            onPress={scrollToBottom}
            className="absolute bottom-[188px] right-4 z-20 rounded-full border border-[#355987] bg-[#0f213a] px-3 py-2"
          >
            <Text className="text-xs font-semibold text-[#c9e2ff]">Bottom</Text>
          </Pressable>
        ) : null}

        <View
          className="border-t border-[#16253d] bg-[#090f1a] pt-2"
          style={{
            paddingBottom: Math.max(insets.bottom, 8),
          }}
        >
          {keyboardVisible ? (
            <View className="mb-2 flex-row justify-end">
              <Pressable
                onPress={() => Keyboard.dismiss()}
                className="rounded-full border border-[#355987] bg-[#0f213a] px-3 py-1.5"
              >
                <Text className="text-xs font-semibold text-[#c9e2ff]">Hide Keyboard</Text>
              </Pressable>
            </View>
          ) : null}
          <View className="mb-2 flex-row gap-2">
            <Pressable
              onPress={() => setOpenDropdown("model")}
              className="h-9 flex-1 flex-row items-center justify-between rounded-full border border-[#355987] bg-[#0f213a] px-3"
            >
              <Text className="text-sm font-semibold text-[#c9e2ff]">
                {modelOptions.find((option) => option.value === selectedModel)?.label ?? "Auto"}
              </Text>
              <Text className="text-sm font-semibold text-[#c9e2ff]">^</Text>
            </Pressable>
            <Pressable
              onPress={() => setOpenDropdown("reasoning")}
              className="h-9 flex-1 flex-row items-center justify-between rounded-full border border-[#355987] bg-[#0f213a] px-3"
            >
              <Text className="text-sm font-semibold text-[#c9e2ff]">
                {currentReasoningOptions.find((option) => option.value === selectedReasoning)?.label ?? "Auto"}
              </Text>
              <Text className="text-sm font-semibold text-[#c9e2ff]">^</Text>
            </Pressable>
          </View>

          <View className="flex-row items-end gap-2">
            <TextInput
              value={composerText}
              onChangeText={setComposerText}
              placeholder="Continue this thread..."
              placeholderTextColor="#6e86a8"
              multiline
              className="max-h-36 flex-1 rounded-2xl border border-[#2a3f60] bg-[#0d1628] px-4 py-3 text-sm text-[#e6edf7]"
            />
            <Pressable
              disabled={sending || !composerText.trim()}
              onPress={onSend}
              className={`min-w-[92px] rounded-2xl px-4 py-3 ${
                sending || !composerText.trim() ? "bg-[#314763]" : "bg-[#3a80d9]"
              }`}
            >
              <Text className="text-center text-sm font-bold text-white">{sending ? "..." : "Send"}</Text>
            </Pressable>
          </View>
        </View>
      </View>
      </KeyboardAvoidingView>

      <Modal transparent visible={openDropdown !== null} animationType="fade" onRequestClose={() => setOpenDropdown(null)}>
        <Pressable className="flex-1 bg-black/55 px-4 pt-24" onPress={() => setOpenDropdown(null)}>
          <Pressable
            className="rounded-xl border border-[#2a3c5a] bg-[#111826] p-2"
            onPress={(event) => {
              event.stopPropagation();
            }}
          >
            {(openDropdown === "model" ? modelOptions : currentReasoningOptions).map((option) => {
              const isModel = openDropdown === "model";
              const active = isModel ? selectedModel === option.value : selectedReasoning === option.value;
              return (
                <Pressable
                  key={`${openDropdown}-${option.label}`}
                  className={`rounded-lg px-3 py-3 ${active ? "bg-[#1d3558]" : "bg-transparent"}`}
                  onPress={() => {
                    if (isModel) {
                      setSelectedModel(option.value as string | null);
                    } else {
                      setSelectedReasoning(option.value as ReasoningEffort | null);
                    }
                    setOpenDropdown(null);
                  }}
                >
                  <Text className={`text-base ${active ? "font-semibold text-[#d9e9ff]" : "text-[#9fb2cd]"}`}>{option.label}</Text>
                </Pressable>
              );
            })}
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}
