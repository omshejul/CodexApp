import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  LayoutChangeEvent,
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
import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";
import * as Clipboard from "expo-clipboard";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import {
  ApiHttpError,
  ReauthRequiredError,
  clearThreadGoal,
  hasStoredPairing,
  getInteractiveRequests,
  getGatewayOptions,
  getStreamConfig,
  getThreadGoal,
  getThreads,
  getThreadFiles,
  getThread,
  getThreadEvents,
  interruptThreadTurn,
  getQueuedThreadMessages,
  queueThreadMessage,
  removeQueuedThreadMessage,
  steerQueuedThreadMessage,
  type QueuedThreadMessage,
  type ThreadGoal,
  respondToInteractiveRequest,
  resumeThread,
  sendThreadMessage,
  setThreadGoal,
} from "@/lib/api";
import {
  type CopyGroups,
  extractApiErrorMessage,
  ThreadTurnRow,
  type ThreadImageProxyConfig,
  useSmoothedFlag,
} from "@/components/thread/thread-renderers";
import { extractDeltaText, RenderedTurn, toRenderedTurns } from "@/lib/turns";
import { ThreadHeader } from "@/components/thread/screen/ThreadHeader";
import { LiveFooter } from "@/components/thread/screen/LiveFooter";
import { ThreadTimeline } from "@/components/thread/screen/ThreadTimeline";
import { ThreadComposer } from "@/components/thread/screen/ThreadComposer";
import { PlanModeToast } from "@/components/thread/screen/PlanModeToast";
import { OptionPickerModal } from "@/components/thread/screen/OptionPickerModal";
import { TerminalOutputModal } from "@/components/thread/screen/TerminalOutputModal";
import { ImagePreviewModal } from "@/components/thread/screen/ImagePreviewModal";

import {
  threadComposerPreferencesByThreadId,
} from "@/components/thread/screen/cache";
import {
  AUTO_FOLLOW_THROTTLE_MS,
  DEFAULT_REASONING_OPTIONS,
  LIVE_FLUSH_INTERVAL_MS,
  STREAM_METHOD_INTERACTIVE_EXPIRED,
  STREAM_METHOD_INTERACTIVE_REQUESTED,
  STREAM_METHOD_INTERACTIVE_RESPONDED,
  STREAM_METHOD_QUEUE_DISPATCHED,
  STREAM_METHOD_QUEUE_DISPATCH_FAILED,
  STREAM_METHOD_QUEUE_ENQUEUED,
  STREAM_METHOD_QUEUE_REMOVED,
  STREAM_TURN_APPEND_BATCH_MS,
  TERMINAL_TURN_METHODS,
  type CollaborationMode,
  type ComposerSelection,
  type LiveStreamBucket,
  type LiveStreamState,
  type ModelOption,
  type OpenDropdown,
  type PendingImage,
  type PendingRequestUserInput,
  type ReasoningEffort,
  type ReasoningOption,
  type StreamStatusTone,
} from "@/components/thread/screen/types";
import {
  asRecord,
  cacheTransientChangeSummaryTurn,
  createEmptyLiveStreamState,
  extractActivityFromEvent,
  extractChangeSummaryFromEvent,
  extractCollaborationModeFromSettingsEvent,
  extractGoalFromEventParams,
  extractInteractiveLifecycleRequestId,
  extractReasoningText,
  extractTurnIdFromUnknown,
  extractWebSearchQueries,
  findActiveMentionToken,
  firstNonEmptyString,
  getThreadPreferenceKey,
  hasLiveStreamContent,
  isLikelyWebSearchToolName,
  isMissingQueueRouteError,
  mergeTurnsBySignature,
  mergeWithTransientChangeSummaryCache,
  parseSsePayload,
  queuedMessageSummary,
  sameLiveStreamState,
  sortQueuedMessages,
  toPendingRequestUserInput,
  toPendingRequestUserInputList,
  toPersistedEventTurns,
  toQueuedThreadMessage,
  toQueuedThreadMessageRequest,
  toWebSearchActivity,
  turnContentSignature,
  turnsSignature,
  uniqueAnswerValues,
  upsertPendingRequestUserInput,
  upsertQueuedMessage,
} from "@/components/thread/screen/helpers";

const THREAD_GOAL_STATUS_LABELS: Record<ThreadGoal["status"], string> = {
  active: "Active",
  paused: "Paused",
  blocked: "Blocked",
  usageLimited: "Usage limited",
  budgetLimited: "Budget limited",
  complete: "Complete",
};

function formatGoalDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function formatGoalTokens(goal: ThreadGoal): string {
  const used = goal.tokensUsed.toLocaleString();
  if (goal.tokenBudget === null) {
    return `${used} tokens`;
  }
  return `${used}/${goal.tokenBudget.toLocaleString()} tokens`;
}

export default function ThreadScreen() {
  type ActiveTerminalView = { mode: "snapshot"; detail: string } | { mode: "live"; fallbackDetail: string };

  const { id, gatewayId: gatewayIdParam } = useLocalSearchParams<{ id: string; gatewayId?: string }>();
  const threadId = useMemo(() => (Array.isArray(id) ? id[0] : id), [id]);
  const gatewayId = useMemo(
    () => (Array.isArray(gatewayIdParam) ? gatewayIdParam[0] : gatewayIdParam),
    [gatewayIdParam]
  );
  const threadPreferenceKey = useMemo(
    () => (threadId ? getThreadPreferenceKey(threadId, gatewayId) : null),
    [gatewayId, threadId]
  );
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
  const [liveSnapshot, setLiveSnapshot] = useState<LiveStreamState>(() => createEmptyLiveStreamState());
  const [isThinking, setIsThinking] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [selectedReasoning, setSelectedReasoning] = useState<ReasoningEffort | null>(null);
  const [selectedCollaborationMode, setSelectedCollaborationMode] = useState<CollaborationMode>("default");
  const [planModeToast, setPlanModeToast] = useState<string | null>(null);
  const [threadGoal, setThreadGoalState] = useState<ThreadGoal | null>(null);
  const [goalDraft, setGoalDraft] = useState("");
  const [goalPending, setGoalPending] = useState(false);
  const [goalError, setGoalError] = useState<string | null>(null);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [expandedActivityIds, setExpandedActivityIds] = useState<Set<string>>(new Set());
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
  const [activeTerminalView, setActiveTerminalView] = useState<ActiveTerminalView | null>(null);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [queuedMessages, setQueuedMessages] = useState<QueuedThreadMessage[]>([]);
  const [queueActionPendingIds, setQueueActionPendingIds] = useState<Set<string>>(new Set());
  const [queueErrorsById, setQueueErrorsById] = useState<Record<string, string>>({});
  const [queueUnsupported, setQueueUnsupported] = useState(false);
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [headerTitle, setHeaderTitle] = useState("Chat");
  const [headerPath, setHeaderPath] = useState<string | null>(null);
  const [lastCopiedTurnId, setLastCopiedTurnId] = useState<string | null>(null);
  const [lastCopiedDiffId, setLastCopiedDiffId] = useState<string | null>(null);
  const [wrappedDiffIds, setWrappedDiffIds] = useState<Set<string>>(new Set());
  const [expandedDiffIds, setExpandedDiffIds] = useState<Set<string>>(new Set());
  const [wrapToast, setWrapToast] = useState<{ diffId: string; wrapped: boolean } | null>(null);
  const [pendingRequestUserInputs, setPendingRequestUserInputs] = useState<PendingRequestUserInput[]>([]);
  const [requestSelectionsByRequest, setRequestSelectionsByRequest] = useState<Record<string, Record<string, string[]>>>({});
  const [requestTextByRequest, setRequestTextByRequest] = useState<Record<string, Record<string, string>>>({});
  const [requestQuestionIndexByRequest, setRequestQuestionIndexByRequest] = useState<Record<string, number>>({});
  const [requestErrorsById, setRequestErrorsById] = useState<Record<string, string>>({});
  const [requestSubmittingIds, setRequestSubmittingIds] = useState<Set<string>>(new Set());
  const [suppressRowAnimations, setSuppressRowAnimations] = useState(false);
  const [imageProxyConfig, setImageProxyConfig] = useState<ThreadImageProxyConfig | null>(null);
  const [liveBucketOrder, setLiveBucketOrder] = useState<LiveStreamBucket[]>([]);
  const [showScrollToBottomButton, setShowScrollToBottomButton] = useState(false);
  const [composerHeight, setComposerHeight] = useState(0);

  const streamSocketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const liveLastFlushAtRef = useRef(0);
  const liveIndicatorHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const optionsLastLoadedAtRef = useRef(0);
  const optionsRefreshPromiseRef = useRef<Promise<void> | null>(null);
  const selectedModelRef = useRef<string | null>(null);
  const preferencesInitThreadIdRef = useRef<string | null>(null);
  const preferencesInitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const composerInputRef = useRef<TextInput>(null);
  const listRef = useRef<FlatList<RenderedTurn>>(null);
  const followBottomRef = useRef(true);
  const draggingRef = useRef(false);
  const initialSnapDoneRef = useRef(false);
  const seenEventIdsRef = useRef(new Set<string>());
  const turnsSignatureRef = useRef("");
  const mentionRequestRef = useRef(0);
  const wrapToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveBufferRef = useRef<LiveStreamState>(createEmptyLiveStreamState());
  const autoFollowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoFollowLastRunAtRef = useRef(0);
  const suppressRowAnimationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clientTurnIdRef = useRef(0);
  const bufferedStreamTurnsRef = useRef<RenderedTurn[]>([]);
  const bufferedStreamTurnsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seenTurnSignaturesRef = useRef(new Set<string>());

  const makeClientTurnId = useCallback((prefix: string): string => {
    clientTurnIdRef.current += 1;
    return `${prefix}-${Date.now()}-${clientTurnIdRef.current}`;
  }, []);

  const clearBufferedStreamTurns = useCallback(() => {
    if (bufferedStreamTurnsTimerRef.current) {
      clearTimeout(bufferedStreamTurnsTimerRef.current);
      bufferedStreamTurnsTimerRef.current = null;
    }
    bufferedStreamTurnsRef.current = [];
  }, [gatewayId]);

  const flushBufferedStreamTurns = useCallback(() => {
    if (bufferedStreamTurnsTimerRef.current) {
      clearTimeout(bufferedStreamTurnsTimerRef.current);
      bufferedStreamTurnsTimerRef.current = null;
    }

    const queuedTurns = bufferedStreamTurnsRef.current;
    if (queuedTurns.length === 0) {
      return;
    }

    bufferedStreamTurnsRef.current = [];
    setTurns((existing) => {
      for (const queuedTurn of queuedTurns) {
        seenTurnSignaturesRef.current.add(turnContentSignature(queuedTurn));
      }
      return mergeTurnsBySignature([...existing, ...queuedTurns]);
    });
  }, []);

  const enqueueBufferedStreamTurn = useCallback(
    (turn: RenderedTurn) => {
      bufferedStreamTurnsRef.current.push(turn);
      if (bufferedStreamTurnsTimerRef.current) {
        return;
      }

      bufferedStreamTurnsTimerRef.current = setTimeout(() => {
        flushBufferedStreamTurns();
      }, STREAM_TURN_APPEND_BATCH_MS);
    },
    [flushBufferedStreamTurns]
  );

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
  const clearRequestError = useCallback((requestId: string) => {
    setRequestErrorsById((existing) => {
      if (!(requestId in existing)) {
        return existing;
      }
      const { [requestId]: _removed, ...rest } = existing;
      return rest;
    });
  }, []);

  const clearQueueError = useCallback((messageId: string) => {
    setQueueErrorsById((existing) => {
      if (!(messageId in existing)) {
        return existing;
      }
      const { [messageId]: _removed, ...rest } = existing;
      return rest;
    });
  }, []);

  const refreshQueuedMessages = useCallback(async () => {
    if (!threadId) {
      return;
    }
    try {
      const messages = await getQueuedThreadMessages(threadId, gatewayId);
      setQueuedMessages(sortQueuedMessages(messages));
      setQueueUnsupported(false);
    } catch (error) {
      if (isMissingQueueRouteError(error)) {
        setQueueUnsupported(true);
        setQueuedMessages([]);
        return;
      }
      throw error;
    }
  }, [gatewayId, threadId]);

  const refreshInteractiveRequests = useCallback(async () => {
    if (!threadId) {
      return;
    }
    const payload = await getInteractiveRequests(threadId, gatewayId);
    setPendingRequestUserInputs(toPendingRequestUserInputList(payload.requests));
  }, [gatewayId, threadId]);

  const upsertInteractiveRequest = useCallback((candidate: PendingRequestUserInput) => {
    setPendingRequestUserInputs((existing) => upsertPendingRequestUserInput(existing, candidate));
  }, []);

  const removeInteractiveRequestById = useCallback((requestId: string) => {
    setPendingRequestUserInputs((existing) => existing.filter((request) => request.id !== requestId));
  }, []);

  useEffect(() => {
    const activeRequestIds = new Set(pendingRequestUserInputs.map((request) => request.id));

    const pruneByRequest = <T,>(record: Record<string, T>): Record<string, T> => {
      const next: Record<string, T> = {};
      let changed = false;
      for (const [key, value] of Object.entries(record)) {
        if (activeRequestIds.has(key)) {
          next[key] = value;
        } else {
          changed = true;
        }
      }
      return changed ? next : record;
    };

    setRequestSelectionsByRequest((existing) => pruneByRequest(existing));
    setRequestTextByRequest((existing) => pruneByRequest(existing));
    setRequestQuestionIndexByRequest((existing) => pruneByRequest(existing));
    setRequestErrorsById((existing) => pruneByRequest(existing));
    setRequestSubmittingIds((existing) => {
      let changed = false;
      const next = new Set<string>();
      for (const requestId of existing) {
        if (activeRequestIds.has(requestId)) {
          next.add(requestId);
        } else {
          changed = true;
        }
      }
      return changed ? next : existing;
    });
  }, [pendingRequestUserInputs]);

  useEffect(() => {
    const activeQueuedIds = new Set(queuedMessages.map((message) => message.id));

    setQueueErrorsById((existing) => {
      const next: Record<string, string> = {};
      let changed = false;
      for (const [id, value] of Object.entries(existing)) {
        if (activeQueuedIds.has(id)) {
          next[id] = value;
        } else {
          changed = true;
        }
      }
      return changed ? next : existing;
    });

    setQueueActionPendingIds((existing) => {
      const next = new Set<string>();
      let changed = false;
      for (const id of existing) {
        if (activeQueuedIds.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }
      return changed ? next : existing;
    });
  }, [queuedMessages]);

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
    if (planModeToast === null) return;
    const t = setTimeout(() => setPlanModeToast(null), 1500);
    return () => clearTimeout(t);
  }, [planModeToast]);

  useEffect(() => {
    if (selectedReasoning === null) {
      return;
    }
    if (currentReasoningOptions.length === 0) {
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
    if (modelOptions.length === 0) {
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
    if (preferencesInitTimerRef.current) {
      clearTimeout(preferencesInitTimerRef.current);
      preferencesInitTimerRef.current = null;
    }

    preferencesInitThreadIdRef.current = null;

    if (!threadPreferenceKey) {
      return;
    }

    const saved = threadComposerPreferencesByThreadId.get(threadPreferenceKey);
    setSelectedModel(saved?.model ?? null);
    setSelectedReasoning(saved?.reasoning ?? null);
    setSelectedCollaborationMode(saved?.collaborationMode ?? "default");

    preferencesInitTimerRef.current = setTimeout(() => {
      preferencesInitThreadIdRef.current = threadPreferenceKey;
      preferencesInitTimerRef.current = null;
    }, 0);

    return () => {
      if (preferencesInitTimerRef.current) {
        clearTimeout(preferencesInitTimerRef.current);
        preferencesInitTimerRef.current = null;
      }
    };
  }, [threadPreferenceKey]);

  useEffect(() => {
    if (!threadPreferenceKey) {
      return;
    }
    if (preferencesInitThreadIdRef.current !== threadPreferenceKey) {
      return;
    }

    threadComposerPreferencesByThreadId.set(threadPreferenceKey, {
      model: selectedModel,
      reasoning: selectedReasoning,
      collaborationMode: selectedCollaborationMode,
    });
  }, [selectedCollaborationMode, selectedModel, selectedReasoning, threadPreferenceKey]);

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
    const payload = await getGatewayOptions(gatewayId);

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
    optionsLastLoadedAtRef.current = Date.now();
    setOptionsLoaded(nextModelOptions.length > 0);
  }, []);

  const refreshGatewayOptionsIfNeeded = useCallback(async () => {
    const optionsStale = Date.now() - optionsLastLoadedAtRef.current > 60_000;
    if (optionsLoaded && !optionsStale) {
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

  const flushLiveSnapshot = useCallback(() => {
    if (liveFlushTimerRef.current) {
      clearTimeout(liveFlushTimerRef.current);
      liveFlushTimerRef.current = null;
    }
    liveLastFlushAtRef.current = Date.now();
    const next = liveBufferRef.current;
    setLiveSnapshot((current) => (sameLiveStreamState(current, next) ? current : { ...next }));
  }, []);

  const scheduleLiveSnapshotFlush = useCallback(() => {
    const elapsedMs = Date.now() - liveLastFlushAtRef.current;
    if (elapsedMs >= LIVE_FLUSH_INTERVAL_MS) {
      flushLiveSnapshot();
      return;
    }
    if (liveFlushTimerRef.current) {
      return;
    }
    const waitMs = Math.max(0, LIVE_FLUSH_INTERVAL_MS - elapsedMs);
    liveFlushTimerRef.current = setTimeout(() => {
      liveFlushTimerRef.current = null;
      flushLiveSnapshot();
    }, waitMs);
  }, [flushLiveSnapshot]);

  const appendLiveChunk = useCallback(
    (bucket: LiveStreamBucket, chunk: string) => {
      if (!chunk) {
        return;
      }
      if (!liveBufferRef.current[bucket]) {
        setLiveBucketOrder((existing) => (existing.includes(bucket) ? existing : [...existing, bucket]));
      }
      liveBufferRef.current[bucket] = `${liveBufferRef.current[bucket]}${chunk}`;
      if (bucket === "terminalOutput") {
        liveBufferRef.current.terminalOutputComplete = false;
      }
      scheduleLiveSnapshotFlush();
    },
    [scheduleLiveSnapshotFlush]
  );

  const setTerminalOutputComplete = useCallback(
    (complete: boolean) => {
      if (liveBufferRef.current.terminalOutputComplete === complete) {
        return;
      }
      liveBufferRef.current.terminalOutputComplete = complete;
      scheduleLiveSnapshotFlush();
    },
    [scheduleLiveSnapshotFlush]
  );

  const clearLiveBuffers = useCallback(() => {
    if (liveFlushTimerRef.current) {
      clearTimeout(liveFlushTimerRef.current);
      liveFlushTimerRef.current = null;
    }
    liveBufferRef.current = createEmptyLiveStreamState();
    liveLastFlushAtRef.current = 0;
    setLiveBucketOrder((existing) => (existing.length > 0 ? [] : existing));
    setLiveSnapshot((current) => (hasLiveStreamContent(current) ? createEmptyLiveStreamState() : current));
  }, []);

  const applyPersistedThreadState = useCallback(
    (
      threadTurns: unknown[],
      eventRows: Array<{ id: number; method: string; params?: unknown; createdAt?: string; turnId?: string }>,
      interactiveRequests: Awaited<ReturnType<typeof getInteractiveRequests>> | null,
      queuedMessagesResponse: QueuedThreadMessage[] | null,
      options?: { clearLiveAfter?: boolean }
    ) => {
      const rendered = toRenderedTurns(threadTurns);
      const withPersistedEvents = toPersistedEventTurns(eventRows, rendered);
      const withPersistedAndTransient = mergeWithTransientChangeSummaryCache(withPersistedEvents, threadPreferenceKey);
      const nextSignature = turnsSignature(withPersistedAndTransient);

      turnsSignatureRef.current = nextSignature;
      clearBufferedStreamTurns();
      setTurns(withPersistedAndTransient);
      seenTurnSignaturesRef.current = new Set(withPersistedAndTransient.map((item) => turnContentSignature(item)));

      if (interactiveRequests) {
        setPendingRequestUserInputs(toPendingRequestUserInputList(interactiveRequests.requests));
      }
      if (queuedMessagesResponse) {
        setQueuedMessages(sortQueuedMessages(queuedMessagesResponse));
      }

      if (options?.clearLiveAfter) {
        clearLiveBuffers();
      }
    },
    [clearBufferedStreamTurns, clearLiveBuffers, threadPreferenceKey]
  );

  const reloadPersistedThreadState = useCallback(
    async (options?: { clearLiveAfter?: boolean }) => {
      if (!threadId) {
        return;
      }
      const [thread, eventsResponse, interactiveResponse, queuedResponse, goalResponse] = await Promise.all([
        getThread(threadId, gatewayId),
        getThreadEvents(threadId, gatewayId),
        getInteractiveRequests(threadId, gatewayId).catch(() => null),
        getQueuedThreadMessages(threadId, gatewayId).catch(() => null),
        getThreadGoal(threadId, gatewayId).catch(() => undefined),
      ]);
      if (goalResponse) {
        setThreadGoalState(goalResponse.goal);
      }
      applyPersistedThreadState(thread.turns, eventsResponse.events, interactiveResponse, queuedResponse, options);
    },
    [applyPersistedThreadState, gatewayId, threadId]
  );

  const finalizeLiveSnapshotToTurns = useCallback(() => {
    flushBufferedStreamTurns();
    if (liveFlushTimerRef.current) {
      clearTimeout(liveFlushTimerRef.current);
      liveFlushTimerRef.current = null;
    }
    setSuppressRowAnimations(true);
    if (suppressRowAnimationTimerRef.current) {
      clearTimeout(suppressRowAnimationTimerRef.current);
    }
    suppressRowAnimationTimerRef.current = setTimeout(() => {
      suppressRowAnimationTimerRef.current = null;
      setSuppressRowAnimations(false);
    }, 700);

    reloadPersistedThreadState({ clearLiveAfter: true }).catch(() => {
      // Keep the live snapshot visible until periodic sync catches up.
    });

    liveBufferRef.current = createEmptyLiveStreamState();
    liveLastFlushAtRef.current = 0;
  }, [flushBufferedStreamTurns, reloadPersistedThreadState]);

  useEffect(() => {
    if (!threadId) {
      return;
    }

    let active = true;
    initialSnapDoneRef.current = false;
    followBottomRef.current = true;
    draggingRef.current = false;
    autoFollowLastRunAtRef.current = 0;
    if (autoFollowTimerRef.current) {
      clearTimeout(autoFollowTimerRef.current);
      autoFollowTimerRef.current = null;
    }
    clearLiveBuffers();
    clearBufferedStreamTurns();
    setIsThinking(false);
    setActiveTurnId(null);
    setHeaderTitle("Chat");
    setHeaderPath(null);
    setTurns([]);
    setImageProxyConfig(null);
    setExpandedActivityIds(new Set());
    setExpandedDiffIds(new Set());
    setActiveTerminalView(null);
    setPendingRequestUserInputs([]);
    setRequestSelectionsByRequest({});
    setRequestTextByRequest({});
    setRequestErrorsById({});
    setRequestSubmittingIds(new Set());
    setQueuedMessages([]);
    setQueueActionPendingIds(new Set());
    setQueueErrorsById({});
    setQueueUnsupported(false);
    setThreadGoalState(null);
    setGoalDraft("");
    setGoalError(null);
    setGoalPending(false);
    turnsSignatureRef.current = "";
    seenTurnSignaturesRef.current = new Set();
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
        const stream = await getStreamConfig(threadId, gatewayId);
        if (!active) {
          return;
        }
        let latestObservedTurnId: string | null = null;

        try {
          const parsedStreamUrl = new URL(stream.wsUrl);
          const baseProtocol = parsedStreamUrl.protocol === "wss:" ? "https:" : "http:";
          const nextProxyConfig: ThreadImageProxyConfig = {
            baseUrl: `${baseProtocol}//${parsedStreamUrl.host}`,
            accessToken: stream.token,
          };
          setImageProxyConfig((existing) =>
            existing &&
            existing.baseUrl === nextProxyConfig.baseUrl &&
            existing.accessToken === nextProxyConfig.accessToken
              ? existing
              : nextProxyConfig
          );
        } catch {
          setImageProxyConfig(null);
        }

        streamSocketRef.current?.close();
        const socket = new WebSocket(stream.wsUrl);
        streamSocketRef.current = socket;

        socket.onopen = () => {
          reconnectAttemptRef.current = 0;
          markConnectionRecovered();
          refreshInteractiveRequests().catch(() => {
            // Keep the current interactive queue if the endpoint is temporarily unavailable.
          });
          refreshQueuedMessages().catch(() => {
            // Keep stale queued messages visible until a successful refresh.
          });
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
          const isTerminalTurnMethod = TERMINAL_TURN_METHODS.has(method);
          const observedTurnId = extractTurnIdFromUnknown(payload.params);
          if (observedTurnId && !isTerminalTurnMethod) {
            latestObservedTurnId = observedTurnId;
            setActiveTurnId(observedTurnId);
          }

          if (method === "stream/keepalive" || method === "stream/ready") {
            return;
          }

          if (method === "thread/goal/updated") {
            const nextGoal = extractGoalFromEventParams(payload.params);
            if (nextGoal) {
              setThreadGoalState(nextGoal);
              setGoalError(null);
            }
            return;
          }

          if (method === "thread/goal/cleared") {
            setThreadGoalState(null);
            setGoalError(null);
            return;
          }

          if (method === "thread/settings/updated") {
            const nextMode = extractCollaborationModeFromSettingsEvent(payload.params);
            if (nextMode) {
              setSelectedCollaborationMode(nextMode);
            }
            return;
          }

          if (method === STREAM_METHOD_QUEUE_ENQUEUED) {
            const paramsRecord = asRecord(payload.params);
            const queuedMessage = toQueuedThreadMessage(paramsRecord?.message);
            if (queuedMessage) {
              setQueuedMessages((existing) => upsertQueuedMessage(existing, queuedMessage));
              clearQueueError(queuedMessage.id);
            }
            return;
          }

          if (method === STREAM_METHOD_QUEUE_REMOVED) {
            const paramsRecord = asRecord(payload.params);
            const removedId = firstNonEmptyString(paramsRecord?.id);
            if (removedId) {
              setQueuedMessages((existing) => existing.filter((message) => message.id !== removedId));
              clearQueueError(removedId);
              setQueueActionPendingIds((existing) => {
                if (!existing.has(removedId)) {
                  return existing;
                }
                const next = new Set(existing);
                next.delete(removedId);
                return next;
              });
            }
            return;
          }

          if (method === STREAM_METHOD_QUEUE_DISPATCHED) {
            const paramsRecord = asRecord(payload.params);
            const dispatchedId = firstNonEmptyString(paramsRecord?.id);
            const dispatchedTurnId = firstNonEmptyString(paramsRecord?.turnId);
            const dispatchedRequest = toQueuedThreadMessageRequest(paramsRecord?.request);

            if (dispatchedId) {
              setQueuedMessages((existing) => existing.filter((message) => message.id !== dispatchedId));
              clearQueueError(dispatchedId);
              setQueueActionPendingIds((existing) => {
                if (!existing.has(dispatchedId)) {
                  return existing;
                }
                const next = new Set(existing);
                next.delete(dispatchedId);
                return next;
              });
            }
            if (dispatchedTurnId) {
              latestObservedTurnId = dispatchedTurnId;
              setActiveTurnId(dispatchedTurnId);
            }
            if (dispatchedRequest) {
              const summary = queuedMessageSummary(dispatchedRequest);
              if (summary.text || summary.imageCount > 0) {
                const candidate: RenderedTurn = {
                  id: makeClientTurnId("queued-user"),
                  role: "user",
                  text: summary.text,
                  images: dispatchedRequest.images?.map((image) => image.imageUrl) ?? [],
                  turnId: dispatchedTurnId ?? undefined,
                };
                const candidateSignature = turnContentSignature(candidate);
                if (!seenTurnSignaturesRef.current.has(candidateSignature)) {
                  seenTurnSignaturesRef.current.add(candidateSignature);
                  setTurns((existing) => [...existing, candidate]);
                  followBottomRef.current = true;
                }
              }
            }
            return;
          }

          if (method === STREAM_METHOD_QUEUE_DISPATCH_FAILED) {
            const paramsRecord = asRecord(payload.params);
            const failedId = firstNonEmptyString(paramsRecord?.id);
            const failedError =
              firstNonEmptyString(paramsRecord?.error) ?? "Unable to dispatch queued message.";
            if (failedId) {
              setQueueErrorsById((existing) => ({
                ...existing,
                [failedId]: failedError,
              }));
              setQueueActionPendingIds((existing) => {
                if (!existing.has(failedId)) {
                  return existing;
                }
                const next = new Set(existing);
                next.delete(failedId);
                return next;
              });
            }
            return;
          }

          if (method === STREAM_METHOD_INTERACTIVE_REQUESTED) {
            const paramsRecord = asRecord(payload.params);
            const request = toPendingRequestUserInput(paramsRecord?.request ?? payload.params);
            if (request) {
              upsertInteractiveRequest(request);
            }
            return;
          }

          if (method === STREAM_METHOD_INTERACTIVE_RESPONDED || method === STREAM_METHOD_INTERACTIVE_EXPIRED) {
            const requestId = extractInteractiveLifecycleRequestId(payload.params);
            if (requestId) {
              removeInteractiveRequestById(requestId);
            }
            return;
          }

          const isCommandExecutionCompleted = (() => {
            if (method !== "item/completed" && method !== "codex/event/item_completed") {
              return false;
            }
            if (!payload.params || typeof payload.params !== "object") {
              return false;
            }
            const record = payload.params as Record<string, unknown>;
            const nestedMsg = record.msg && typeof record.msg === "object" ? (record.msg as Record<string, unknown>) : null;
            const item = record.item ?? nestedMsg?.item;
            if (!item || typeof item !== "object") {
              return false;
            }
            const type = typeof (item as Record<string, unknown>).type === "string" ? ((item as Record<string, unknown>).type as string) : "";
            return type.toLowerCase() === "commandexecution";
          })();

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
                latestObservedTurnId = turnId;
                setActiveTurnId(turnId);
              }
            }
          }

          const activity = extractActivityFromEvent(method, payload.params);
          if (activity) {
            if (!seenEventIdsRef.current.has(activity.id)) {
              seenEventIdsRef.current.add(activity.id);
              enqueueBufferedStreamTurn(activity);
            }
            return;
          }

          const summary = extractChangeSummaryFromEvent(method, payload.params);
          if (summary) {
            const summaryTurnId = observedTurnId;
            if (!summaryTurnId) {
              return;
            }
            const candidate: RenderedTurn = {
              id: makeClientTurnId("change"),
              role: "system",
              text: "",
              turnId: summaryTurnId,
              kind: "changeSummary",
              summary,
            };
            enqueueBufferedStreamTurn(candidate);
            if (threadPreferenceKey) {
              cacheTransientChangeSummaryTurn(threadPreferenceKey, candidate);
            }
            return;
          }

          if (method.includes("commandexecution/outputdelta")) {
            const delta = extractDeltaText(payload.params);
            if (delta) {
              appendLiveChunk("terminalOutput", delta);
            }
            return;
          }

          if (isCommandExecutionCompleted) {
            setTerminalOutputComplete(true);
          }

          if (
            method.includes("reasoning/textdelta") ||
            method.includes("reasoning/summarytextdelta") ||
            method.includes("reasoning/summarypartadded")
          ) {
            const chunk = extractReasoningText(payload.params);
            if (chunk) {
              appendLiveChunk("reasoning", chunk);
            }
            return;
          }

          if (method.includes("item/plan/delta") || method.includes("turn/plan/updated")) {
            const delta = extractDeltaText(payload.params);
            const chunk =
              delta ||
              (payload.params && typeof payload.params === "object" ? JSON.stringify(payload.params, null, 2) : "");
            if (chunk) {
              appendLiveChunk("plan", chunk);
            }
            return;
          }

          if (method.includes("item/filechange/outputdelta")) {
            const delta = extractDeltaText(payload.params);
            const chunk =
              delta ||
              (payload.params && typeof payload.params === "object" ? JSON.stringify(payload.params, null, 2) : "");
            if (chunk) {
              appendLiveChunk("fileChanges", chunk);
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
                id: makeClientTurnId("web-search-progress"),
                role: "system",
                text: "",
                kind: "activity",
                activity: toWebSearchActivity(progressQueries),
              };
              const candidateSignature = turnContentSignature(candidate);
              if (!seenTurnSignaturesRef.current.has(candidateSignature)) {
                seenTurnSignaturesRef.current.add(candidateSignature);
                enqueueBufferedStreamTurn(candidate);
              }
            }

            const delta = extractDeltaText(payload.params);
            const chunk =
              delta ||
              (payload.params && typeof payload.params === "object" ? JSON.stringify(payload.params, null, 2) : "");
            if (chunk) {
              appendLiveChunk("toolProgress", chunk);
            }
            return;
          }

          if (method.includes("agentmessage/delta")) {
            const delta = extractDeltaText(payload.params);
            if (delta) {
              appendLiveChunk("assistant", delta);
            }
            return;
          }

          if (method.includes("aborted") || method.includes("interrupt")) {
            latestObservedTurnId = null;
            setIsThinking(false);
            setActiveTurnId(null);
            finalizeLiveSnapshotToTurns();
            return;
          }

          if (isTerminalTurnMethod) {
            latestObservedTurnId = null;
            setIsThinking(false);
            setActiveTurnId(null);
            finalizeLiveSnapshotToTurns();
            return;
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
        await resumeThread(threadId, gatewayId);
        const [thread, eventsResponse, threadsResponse, interactiveResponse, queuedResponse, goalResponse] = await Promise.all([
          getThread(threadId, gatewayId),
          getThreadEvents(threadId, gatewayId),
          getThreads(gatewayId),
          getInteractiveRequests(threadId, gatewayId).catch(() => null),
          getQueuedThreadMessages(threadId, gatewayId).catch(() => [] as QueuedThreadMessage[]),
          getThreadGoal(threadId, gatewayId).catch(() => undefined),
        ]);
        if (!active) {
          return;
        }

        const headerName = thread.name?.trim() || thread.title?.trim() || "Chat";
        const matchingSummary = threadsResponse.threads.find((entry) => entry.id === threadId);
        setHeaderTitle(headerName);
        setHeaderPath(matchingSummary?.cwd?.trim() || null);
        if (goalResponse) {
          setThreadGoalState(goalResponse.goal);
        }

        applyPersistedThreadState(thread.turns, eventsResponse.events, interactiveResponse, queuedResponse);
        setError(null);
        await connectStream();
      } catch (setupError) {
        if (setupError instanceof ReauthRequiredError) {
          const stillPaired = await hasStoredPairing();
          router.replace(stillPaired ? "/threads" : "/pair");
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
      if (autoFollowTimerRef.current) {
        clearTimeout(autoFollowTimerRef.current);
        autoFollowTimerRef.current = null;
      }
      clearLiveBuffers();
      clearBufferedStreamTurns();
      streamSocketRef.current?.close();
      streamSocketRef.current = null;
    };
  }, [
    threadId,
    gatewayId,
    threadPreferenceKey,
    markConnectionRecovered,
    refreshInteractiveRequests,
    refreshQueuedMessages,
    upsertInteractiveRequest,
    removeInteractiveRequestById,
    clearQueueError,
    makeClientTurnId,
    appendLiveChunk,
    finalizeLiveSnapshotToTurns,
    clearLiveBuffers,
    clearBufferedStreamTurns,
    enqueueBufferedStreamTurn,
    setTerminalOutputComplete,
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
        const [thread, eventsResponse, interactiveResponse, queuedResponse, goalResponse] = await Promise.all([
          getThread(threadId, gatewayId),
          getThreadEvents(threadId, gatewayId),
          getInteractiveRequests(threadId, gatewayId).catch(() => null),
          getQueuedThreadMessages(threadId, gatewayId).catch(() => null),
          getThreadGoal(threadId, gatewayId).catch(() => undefined),
        ]);
        if (!active) {
          return;
        }
        if (goalResponse) {
          setThreadGoalState(goalResponse.goal);
        }
        const rendered = toRenderedTurns(thread.turns);
        const withPersistedEvents = toPersistedEventTurns(eventsResponse.events, rendered);
        const withPersistedAndTransient = mergeWithTransientChangeSummaryCache(withPersistedEvents, threadPreferenceKey);
        const nextSignature = turnsSignature(withPersistedAndTransient);
        if (nextSignature !== turnsSignatureRef.current) {
          applyPersistedThreadState(thread.turns, eventsResponse.events, interactiveResponse, queuedResponse, {
            clearLiveAfter: true,
          });
        } else {
          if (interactiveResponse) {
            setPendingRequestUserInputs(toPendingRequestUserInputList(interactiveResponse.requests));
          }
          if (queuedResponse) {
            setQueuedMessages(sortQueuedMessages(queuedResponse));
          }
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
  }, [threadId, gatewayId, threadPreferenceKey, loading, streamStatus.tone, markConnectionRecovered, applyPersistedThreadState]);

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
      }
    };

    loadOptions().catch(() => {
      // ignore, fallback options remain active
    });

    return () => {
      active = false;
    };
  }, [loadGatewayOptions]);

  const keepToBottom = useCallback((animated: boolean) => {
    if (!followBottomRef.current || draggingRef.current) {
      return;
    }
    autoFollowLastRunAtRef.current = Date.now();
    setShowScrollToBottomButton(false);
    listRef.current?.scrollToEnd({ animated: initialSnapDoneRef.current ? animated : false });
    if (!initialSnapDoneRef.current) {
      initialSnapDoneRef.current = true;
    }
  }, []);

  const scheduleAutoFollow = useCallback(
    (animated: boolean) => {
      if (!followBottomRef.current || draggingRef.current) {
        return;
      }
      if (autoFollowTimerRef.current) {
        return;
      }

      const elapsedMs = Date.now() - autoFollowLastRunAtRef.current;
      const waitMs = elapsedMs >= AUTO_FOLLOW_THROTTLE_MS ? 0 : AUTO_FOLLOW_THROTTLE_MS - elapsedMs;
      autoFollowTimerRef.current = setTimeout(() => {
        autoFollowTimerRef.current = null;
        keepToBottom(animated);
      }, waitMs);
    },
    [keepToBottom]
  );

  const streamDotColor =
    streamStatus.tone === "ok" ? "#22c55e" : streamStatus.tone === "warn" ? "#f59e0b" : "#ef4444";
  const indicatorVisible = showLiveIndicator || streamStatus.tone !== "ok";

  useEffect(() => {
    if (!followBottomRef.current || draggingRef.current) {
      return;
    }
    scheduleAutoFollow(false);
  }, [turns, scheduleAutoFollow]);

  useEffect(() => {
    if (!followBottomRef.current || draggingRef.current) {
      return;
    }
    if (!hasLiveStreamContent(liveSnapshot)) {
      return;
    }
    scheduleAutoFollow(true);
  }, [
    liveSnapshot.assistant,
    liveSnapshot.terminalOutput,
    liveSnapshot.reasoning,
    liveSnapshot.plan,
    liveSnapshot.fileChanges,
    liveSnapshot.toolProgress,
    liveSnapshot,
    scheduleAutoFollow,
  ]);

  useEffect(
    () => () => {
      if (autoFollowTimerRef.current) {
        clearTimeout(autoFollowTimerRef.current);
        autoFollowTimerRef.current = null;
      }
      if (suppressRowAnimationTimerRef.current) {
        clearTimeout(suppressRowAnimationTimerRef.current);
        suppressRowAnimationTimerRef.current = null;
      }
      if (bufferedStreamTurnsTimerRef.current) {
        clearTimeout(bufferedStreamTurnsTimerRef.current);
        bufferedStreamTurnsTimerRef.current = null;
      }
      bufferedStreamTurnsRef.current = [];
    },
    []
  );

  const onListScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceFromBottom = contentSize.height - (contentOffset.y + layoutMeasurement.height);
    const isNearBottom = distanceFromBottom < 120;
    // If the user scrolls away from bottom, stop auto-following streamed tokens.
    followBottomRef.current = isNearBottom;
    setShowScrollToBottomButton(!isNearBottom);
  };

  const onListScrollToTop = useCallback(() => {
    // iOS status-bar tap jumps to top without a drag gesture.
    followBottomRef.current = false;
    draggingRef.current = false;
    setShowScrollToBottomButton(true);
    if (autoFollowTimerRef.current) {
      clearTimeout(autoFollowTimerRef.current);
      autoFollowTimerRef.current = null;
    }
  }, []);

  const onScrollToBottom = useCallback(() => {
    followBottomRef.current = true;
    draggingRef.current = false;
    keepToBottom(true);
  }, [keepToBottom]);

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

  const toggleDiffExpand = useCallback((diffId: string) => {
    setExpandedDiffIds((existing) => {
      const next = new Set(existing);
      if (next.has(diffId)) {
        next.delete(diffId);
      } else {
        next.add(diffId);
      }
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
        const payload = await getThreadFiles(
          threadId,
          {
            query: activeMention.query,
            limit: 200,
          },
          gatewayId
        );

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
  }, [activeMention, gatewayId, threadId]);

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

  const setRequestQuestionText = useCallback(
    (requestId: string, questionId: string, value: string) => {
      setRequestTextByRequest((existing) => {
        const requestDraft = existing[requestId] ?? {};
        if (requestDraft[questionId] === value) {
          return existing;
        }
        return {
          ...existing,
          [requestId]: {
            ...requestDraft,
            [questionId]: value,
          },
        };
      });
      clearRequestError(requestId);
    },
    [clearRequestError]
  );

  const toggleRequestQuestionOption = useCallback(
    (requestId: string, questionId: string, optionLabel: string) => {
      setRequestSelectionsByRequest((existing) => {
        const requestDraft = existing[requestId] ?? {};
        const currentValues = requestDraft[questionId] ?? [];
        const nextValues = currentValues.includes(optionLabel)
          ? currentValues.filter((value) => value !== optionLabel)
          : [...currentValues, optionLabel];
        return {
          ...existing,
          [requestId]: {
            ...requestDraft,
            [questionId]: nextValues,
          },
        };
      });
      clearRequestError(requestId);
    },
    [clearRequestError]
  );

  const submitRequestUserInput = useCallback(
    async (request: PendingRequestUserInput) => {
      if (requestSubmittingIds.has(request.id)) {
        return;
      }

      const requestSelections = requestSelectionsByRequest[request.id] ?? {};
      const requestTexts = requestTextByRequest[request.id] ?? {};
      const answersByQuestion: Record<string, { answers: string[] }> = {};

      for (const question of request.questions) {
        const selectedAnswers = requestSelections[question.id] ?? [];
        const textAnswer = (requestTexts[question.id] ?? "").trim();

        const combinedAnswers = question.options
          ? question.isOther && textAnswer
            ? [...selectedAnswers, textAnswer]
            : selectedAnswers
          : textAnswer
          ? [textAnswer]
          : [];

        const normalizedAnswers = uniqueAnswerValues(combinedAnswers);
        if (normalizedAnswers.length === 0) {
          setRequestErrorsById((existing) => ({
            ...existing,
            [request.id]: `${question.header}: an answer is required.`,
          }));
          return;
        }

        answersByQuestion[question.id] = {
          answers: normalizedAnswers,
        };
      }

      setRequestSubmittingIds((existing) => {
        const next = new Set(existing);
        next.add(request.id);
        return next;
      });
      clearRequestError(request.id);

      try {
        await respondToInteractiveRequest(
          request.id,
          {
            answers: answersByQuestion,
          },
          gatewayId
        );
        removeInteractiveRequestById(request.id);
        setRequestSelectionsByRequest((existing) => {
          if (!(request.id in existing)) {
            return existing;
          }
          const { [request.id]: _removed, ...rest } = existing;
          return rest;
        });
        setRequestTextByRequest((existing) => {
          if (!(request.id in existing)) {
            return existing;
          }
          const { [request.id]: _removed, ...rest } = existing;
          return rest;
        });
        setRequestQuestionIndexByRequest((existing) => {
          if (!(request.id in existing)) {
            return existing;
          }
          const { [request.id]: _removed, ...rest } = existing;
          return rest;
        });
      } catch (submitError) {
        setRequestErrorsById((existing) => ({
          ...existing,
          [request.id]: submitError instanceof Error ? submitError.message : "Unable to submit input.",
        }));
        refreshInteractiveRequests().catch(() => {
          // Keep stale queue visible until a successful refresh.
        });
      } finally {
        setRequestSubmittingIds((existing) => {
          if (!existing.has(request.id)) {
            return existing;
          }
          const next = new Set(existing);
          next.delete(request.id);
          return next;
        });
      }
    },
    [
      clearRequestError,
      refreshInteractiveRequests,
      removeInteractiveRequestById,
      setRequestQuestionIndexByRequest,
      requestSelectionsByRequest,
      requestSubmittingIds,
      requestTextByRequest,
    ]
  );

  const onRemoveQueuedMessage = useCallback(
    async (messageId: string) => {
      if (!threadId || queueActionPendingIds.has(messageId)) {
        return;
      }

      setQueueActionPendingIds((existing) => {
        const next = new Set(existing);
        next.add(messageId);
        return next;
      });
      clearQueueError(messageId);

      try {
        await removeQueuedThreadMessage(threadId, messageId, gatewayId);
        setQueuedMessages((existing) => existing.filter((message) => message.id !== messageId));
      } catch (removeError) {
        if (isMissingQueueRouteError(removeError)) {
          setQueueUnsupported(true);
          setQueuedMessages([]);
          setError("Queued messages are not supported by this gateway. Update your gateway.");
          return;
        }
        if (removeError instanceof ReauthRequiredError) {
          const stillPaired = await hasStoredPairing();
          router.replace(stillPaired ? "/threads" : "/pair");
          return;
        }
        setQueueErrorsById((existing) => ({
          ...existing,
          [messageId]: removeError instanceof Error ? removeError.message : "Unable to remove queued message.",
        }));
      } finally {
        setQueueActionPendingIds((existing) => {
          if (!existing.has(messageId)) {
            return existing;
          }
          const next = new Set(existing);
          next.delete(messageId);
          return next;
        });
      }
    },
    [clearQueueError, gatewayId, queueActionPendingIds, threadId]
  );

  const onSteerQueuedMessage = useCallback(
    async (messageId: string) => {
      if (!threadId || queueActionPendingIds.has(messageId)) {
        return;
      }

      setQueueActionPendingIds((existing) => {
        const next = new Set(existing);
        next.add(messageId);
        return next;
      });
      clearQueueError(messageId);

      try {
        const response = await steerQueuedThreadMessage(threadId, messageId, gatewayId);
        if (response.turnId) {
          setActiveTurnId(response.turnId);
        }
        setQueuedMessages((existing) => existing.filter((message) => message.id !== messageId));
      } catch (steerError) {
        if (isMissingQueueRouteError(steerError)) {
          setQueueUnsupported(true);
          setQueuedMessages([]);
          setError("Queued messages are not supported by this gateway. Update your gateway.");
          return;
        }
        if (steerError instanceof ReauthRequiredError) {
          const stillPaired = await hasStoredPairing();
          router.replace(stillPaired ? "/threads" : "/pair");
          return;
        }
        setQueueErrorsById((existing) => ({
          ...existing,
          [messageId]: steerError instanceof Error ? steerError.message : "Unable to steer queued message.",
        }));
      } finally {
        setQueueActionPendingIds((existing) => {
          if (!existing.has(messageId)) {
            return existing;
          }
          const next = new Set(existing);
          next.delete(messageId);
          return next;
        });
      }
    },
    [clearQueueError, gatewayId, queueActionPendingIds, threadId]
  );

  const onSend = async () => {
    if (!threadId || sending) {
      return;
    }
    const text = composerText.trim();
    if (!text && pendingImages.length === 0) {
      return;
    }

    const queuedImages = pendingImages;
    const requestPayload = {
      text: text || undefined,
      images: queuedImages.map((image) => ({ imageUrl: image.imageUrl })),
      model: resolvedSelectedModel ?? undefined,
      reasoningEffort: resolvedSelectedReasoning ?? undefined,
      collaborationMode: resolvedSelectedModel ? selectedCollaborationMode : undefined,
    };

    Keyboard.dismiss();
    setError(null);

    if (isResponding) {
      if (queueUnsupported) {
        setError("This gateway version does not support queued messages. Stop the current response or update your gateway.");
        return;
      }
      setSending(true);
      try {
        const queueResponse = await queueThreadMessage(threadId, requestPayload, gatewayId);
        setQueuedMessages((existing) => upsertQueuedMessage(existing, queueResponse.message));
        clearQueueError(queueResponse.message.id);
        setQueueUnsupported(false);
        setComposerText("");
        setComposerSelection({ start: 0, end: 0 });
        setMentionFiles([]);
        setMentionError(null);
        setPendingImages([]);
      } catch (queueError) {
        if (isMissingQueueRouteError(queueError)) {
          setQueueUnsupported(true);
          setQueuedMessages([]);
          setError("Queued messages are not supported by this gateway. Update your gateway.");
          return;
        }
        if (queueError instanceof ReauthRequiredError) {
          const stillPaired = await hasStoredPairing();
          router.replace(stillPaired ? "/threads" : "/pair");
          return;
        }
        setError(queueError instanceof Error ? queueError.message : "Unable to queue message");
      } finally {
        setSending(false);
      }
      return;
    }

    setComposerText("");
    setComposerSelection({ start: 0, end: 0 });
    setMentionFiles([]);
    setMentionError(null);
    setPendingImages([]);
    setSending(true);

    const optimisticTurnId = makeClientTurnId("local-user");
    setTurns((existing) => {
      const localUserTurn: RenderedTurn = {
        id: optimisticTurnId,
        role: "user",
        text,
        images: queuedImages.map((image) => image.uri),
      };
      seenTurnSignaturesRef.current.add(turnContentSignature(localUserTurn));
      return [...existing, localUserTurn];
    });
    followBottomRef.current = true;

    try {
      const response = await sendThreadMessage(threadId, requestPayload, gatewayId);
      if (response.turnId) {
        setActiveTurnId(response.turnId);
      }
    } catch (sendError) {
      if (sendError instanceof ApiHttpError && sendError.status === 409) {
        try {
          const queueResponse = await queueThreadMessage(threadId, requestPayload, gatewayId);
          setQueuedMessages((existing) => upsertQueuedMessage(existing, queueResponse.message));
          clearQueueError(queueResponse.message.id);
          setQueueUnsupported(false);
          // Remove optimistic local turn when request is queued instead of sent.
          setTurns((existing) => existing.filter((turn) => turn.id !== optimisticTurnId));
          return;
        } catch (queueError) {
          if (isMissingQueueRouteError(queueError)) {
            setQueueUnsupported(true);
            setQueuedMessages([]);
            setTurns((existing) => existing.filter((turn) => turn.id !== optimisticTurnId));
            setError("Queued messages are not supported by this gateway. Update your gateway.");
            return;
          }
          if (queueError instanceof ReauthRequiredError) {
            const stillPaired = await hasStoredPairing();
            router.replace(stillPaired ? "/threads" : "/pair");
            return;
          }
          setError(queueError instanceof Error ? queueError.message : "Unable to queue message");
          return;
        }
      }
      if (sendError instanceof ReauthRequiredError) {
        const stillPaired = await hasStoredPairing();
        router.replace(stillPaired ? "/threads" : "/pair");
        return;
      }
      setError(sendError instanceof Error ? sendError.message : "Unable to send message");
    } finally {
      setSending(false);
    }
  };

  const onSetThreadGoal = useCallback(async () => {
    if (!threadId || goalPending) {
      return;
    }
    const objective = goalDraft.trim();
    if (!objective) {
      return;
    }

    setGoalPending(true);
    setGoalError(null);
    try {
      const response = await setThreadGoal(threadId, { objective, status: "active" }, gatewayId);
      setThreadGoalState(response.goal);
      setGoalDraft("");
    } catch (error) {
      if (error instanceof ReauthRequiredError) {
        const stillPaired = await hasStoredPairing();
        router.replace(stillPaired ? "/threads" : "/pair");
        return;
      }
      setGoalError(error instanceof Error ? error.message : "Unable to set goal");
    } finally {
      setGoalPending(false);
    }
  }, [gatewayId, goalDraft, goalPending, threadId]);

  const onClearThreadGoal = useCallback(async () => {
    if (!threadId || goalPending) {
      return;
    }

    setGoalPending(true);
    setGoalError(null);
    try {
      await clearThreadGoal(threadId, gatewayId);
      setThreadGoalState(null);
    } catch (error) {
      if (error instanceof ReauthRequiredError) {
        const stillPaired = await hasStoredPairing();
        router.replace(stillPaired ? "/threads" : "/pair");
        return;
      }
      setGoalError(error instanceof Error ? error.message : "Unable to clear goal");
    } finally {
      setGoalPending(false);
    }
  }, [gatewayId, goalPending, threadId]);

  const latestKnownTurnId = useMemo(() => {
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turnId = firstNonEmptyString(turns[index]?.turnId);
      if (turnId) {
        return turnId;
      }
    }
    return null;
  }, [turns]);

  const onStopResponse = useCallback(async () => {
    if (!threadId || stopping) {
      return;
    }
    const resolvedTurnId = activeTurnId ?? latestKnownTurnId;

    setStopping(true);
    try {
      await interruptThreadTurn(
        threadId,
        resolvedTurnId
          ? {
              turnId: resolvedTurnId,
            }
          : {},
        gatewayId
      );
      setIsThinking(false);
      setActiveTurnId(null);
      finalizeLiveSnapshotToTurns();
      setError(null);
    } catch (interruptError) {
      setError(interruptError instanceof Error ? interruptError.message : "Unable to stop response");
    } finally {
      setStopping(false);
    }
  }, [
    activeTurnId,
    finalizeLiveSnapshotToTurns,
    gatewayId,
    latestKnownTurnId,
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

  const activeRequestUserInput = pendingRequestUserInputs[0] ?? null;
  const activeRequestSelections = activeRequestUserInput
    ? requestSelectionsByRequest[activeRequestUserInput.id] ?? {}
    : {};
  const activeRequestText = activeRequestUserInput ? requestTextByRequest[activeRequestUserInput.id] ?? {} : {};
  const activeRequestQuestionIndex = activeRequestUserInput
    ? Math.min(
        requestQuestionIndexByRequest[activeRequestUserInput.id] ?? 0,
        Math.max(activeRequestUserInput.questions.length - 1, 0)
      )
    : 0;
  const activeRequestQuestion = activeRequestUserInput?.questions[activeRequestQuestionIndex] ?? null;
  const activeRequestError = activeRequestUserInput ? requestErrorsById[activeRequestUserInput.id] : null;
  const activeRequestSubmitting = activeRequestUserInput ? requestSubmittingIds.has(activeRequestUserInput.id) : false;
  const activeRequestExpiryLabel = activeRequestUserInput
    ? new Date(activeRequestUserInput.expiresAtMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : null;

  const getRequestQuestionAnswers = useCallback(
    (
      requestId: string,
      question: PendingRequestUserInput["questions"][number]
    ): string[] => {
      const requestSelections = requestSelectionsByRequest[requestId] ?? {};
      const requestTexts = requestTextByRequest[requestId] ?? {};
      const selectedAnswers = requestSelections[question.id] ?? [];
      const textAnswer = (requestTexts[question.id] ?? "").trim();

      const combinedAnswers = question.options
        ? question.isOther && textAnswer
          ? [...selectedAnswers, textAnswer]
          : selectedAnswers
        : textAnswer
        ? [textAnswer]
        : [];

      return uniqueAnswerValues(combinedAnswers);
    },
    [requestSelectionsByRequest, requestTextByRequest]
  );

  const onAdvanceRequestQuestion = useCallback(() => {
    if (!activeRequestUserInput || !activeRequestQuestion) {
      return;
    }
    const normalizedAnswers = getRequestQuestionAnswers(activeRequestUserInput.id, activeRequestQuestion);
    if (normalizedAnswers.length === 0) {
      setRequestErrorsById((existing) => ({
        ...existing,
        [activeRequestUserInput.id]: `${activeRequestQuestion.header}: an answer is required.`,
      }));
      return;
    }
    clearRequestError(activeRequestUserInput.id);
    setRequestQuestionIndexByRequest((existing) => ({
      ...existing,
      [activeRequestUserInput.id]: Math.min(
        (existing[activeRequestUserInput.id] ?? 0) + 1,
        activeRequestUserInput.questions.length - 1
      ),
    }));
  }, [activeRequestQuestion, activeRequestUserInput, clearRequestError, getRequestQuestionAnswers]);

  const onBackRequestQuestion = useCallback(() => {
    if (!activeRequestUserInput) {
      return;
    }
    clearRequestError(activeRequestUserInput.id);
    setRequestQuestionIndexByRequest((existing) => ({
      ...existing,
      [activeRequestUserInput.id]: Math.max((existing[activeRequestUserInput.id] ?? 0) - 1, 0),
    }));
  }, [activeRequestUserInput, clearRequestError]);

  const isLiveStreamingActive = hasLiveStreamContent(liveSnapshot);
  const hasActiveTurn = activeTurnId !== null;
  const isResponding = sending || hasActiveTurn || isThinking || isLiveStreamingActive;
  const smoothIsThinking = useSmoothedFlag(isThinking, 240);
  const composerHasDraft = composerText.trim().length > 0 || pendingImages.length > 0;
  const shouldShowStopAction = isResponding && !composerHasDraft;
  const responseStatusText = useMemo(() => {
    if (stopping) {
      return "Stopping response...";
    }
    if (sending) {
      return "Starting response...";
    }
    if (isLiveStreamingActive) {
      return "Receiving output...";
    }
    if (isThinking) {
      return "Thinking...";
    }
    if (hasActiveTurn) {
      return "Working...";
    }
    return null;
  }, [hasActiveTurn, isLiveStreamingActive, isThinking, sending, stopping]);
  const composerActionDisabled = shouldShowStopAction
    ? stopping
    : sending || !composerHasDraft || Boolean(activeRequestUserInput);
  const composerActionIconName = shouldShowStopAction
    ? stopping
      ? "time-outline"
      : "stop-circle-outline"
    : sending
    ? "time-outline"
    : "arrow-up";
  const showMentionSuggestions = Boolean(activeMention);
  const mentionSuggestions = mentionFiles.slice(0, 12);

  const liveFooterTurns: RenderedTurn[] = liveBucketOrder.reduce<RenderedTurn[]>((acc, bucket) => {
    const detail = liveSnapshot[bucket];
    if (!detail) {
      return acc;
    }

    if (bucket === "assistant") {
      acc.push({
        id: "live-assistant",
        role: "assistant",
        text: detail,
        streaming: true,
      });
      return acc;
    }

    const activityTitleByBucket: Record<Exclude<LiveStreamBucket, "assistant">, string> = {
      reasoning: "Reasoning",
      plan: "Plan",
      fileChanges: "File changes",
      toolProgress: "Tool progress",
      terminalOutput: "Terminal output",
    };

    acc.push({
      id: `live-${bucket}`,
      role: "system",
      text: "",
      kind: "activity",
      activity: {
        title: activityTitleByBucket[bucket],
        detail,
      },
      streaming: true,
    });
    return acc;
  }, []);

  const copyGroupKeyForTurn = useCallback((turn: RenderedTurn) => `${turn.role}:${turn.turnId ?? turn.id}`, []);

  const copyGroups = useMemo(() => {
    const lastIndexByKey = new Map<string, number>();
    const textPartsByKey = new Map<string, string[]>();

    turns.forEach((turn, idx) => {
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
  }, [turns, copyGroupKeyForTurn]);

  const webSearchFallbackByIndex = useMemo(() => {
    const fallbackByIndex = new Map<number, string | null>();
    let latestUserPrompt: string | null = null;

    for (let index = 0; index < turns.length; index += 1) {
      fallbackByIndex.set(index, latestUserPrompt);
      const candidate = turns[index];
      if (candidate.role !== "user") {
        continue;
      }
      const trimmed = candidate.text.trim();
      if (trimmed.length > 0) {
        latestUserPrompt = trimmed;
      }
    }

    fallbackByIndex.set(turns.length, latestUserPrompt);
    return fallbackByIndex;
  }, [turns]);

  const latestUserPromptFallback = webSearchFallbackByIndex.get(turns.length) ?? null;

  const onOpenTerminalOutputSnapshot = useCallback((detail: string) => {
    const normalized = detail.trim();
    if (!normalized) {
      return;
    }
    setActiveTerminalView({ mode: "snapshot", detail });
  }, []);

  const onOpenLiveTerminalOutput = useCallback(() => {
    const detail = liveSnapshot.terminalOutput;
    if (!detail.trim()) {
      return;
    }
    setActiveTerminalView({ mode: "live", fallbackDetail: detail });
  }, [liveSnapshot.terminalOutput]);

  const onPlanAction = useCallback((action: "implement" | "revise", _detail: string) => {
    const nextText =
      action === "implement"
        ? "Implement the latest approved plan."
        : "Revise the latest plan. Changes I want:";
    setComposerText(nextText);
    setComposerSelection({ start: nextText.length, end: nextText.length });
    setTimeout(() => {
      composerInputRef.current?.focus();
    }, 10);
  }, []);

  useEffect(() => {
    const detail = liveSnapshot.terminalOutput;
    if (!detail.trim()) {
      return;
    }

    setActiveTerminalView((current) => {
      if (!current || current.mode !== "live" || current.fallbackDetail === detail) {
        return current;
      }
      return { ...current, fallbackDetail: detail };
    });
  }, [liveSnapshot.terminalOutput]);

  const terminalOutputForModal = useMemo(() => {
    if (!activeTerminalView) {
      return null;
    }
    if (activeTerminalView.mode === "snapshot") {
      return activeTerminalView.detail;
    }
    return liveSnapshot.terminalOutput.trim() ? liveSnapshot.terminalOutput : activeTerminalView.fallbackDetail;
  }, [activeTerminalView, liveSnapshot.terminalOutput]);

  const onToggleActivity = useCallback((turnId: string) => {
    setExpandedActivityIds((existing) => {
      const next = new Set(existing);
      if (next.has(turnId)) {
        next.delete(turnId);
      } else {
        next.add(turnId);
      }
      return next;
    });
  }, []);

  const onPreviewTurnImage = useCallback((uri: string) => {
    setPreviewImageUri(uri);
  }, []);

  const renderTurnItem = useCallback(
    ({ item, index }: { item: RenderedTurn; index: number }) => (
      <ThreadTurnRow
        item={item}
        index={index}
        threadId={threadId ?? null}
        imageProxyConfig={imageProxyConfig}
        isLiveStreamingActive={isLiveStreamingActive}
        suppressRowAnimations={suppressRowAnimations}
        wrappedDiffIds={wrappedDiffIds}
        expandedDiffIds={expandedDiffIds}
        wrapToast={wrapToast}
        lastCopiedDiffId={lastCopiedDiffId}
        expandedActivityIds={expandedActivityIds}
        lastCopiedTurnId={lastCopiedTurnId}
        copyGroups={copyGroups}
        webSearchFallback={webSearchFallbackByIndex.get(index) ?? null}
        onToggleDiffWrap={toggleDiffWrap}
        onToggleDiffExpand={toggleDiffExpand}
        onCopyDiffText={copyDiffText}
        onOpenTerminalOutput={onOpenTerminalOutputSnapshot}
        onPlanAction={onPlanAction}
        onToggleActivity={onToggleActivity}
        onPreviewImage={onPreviewTurnImage}
        onCopyTurnText={copyTurnText}
        copyGroupKeyForTurn={copyGroupKeyForTurn}
      />
    ),
    [
      isLiveStreamingActive,
      threadId,
      imageProxyConfig,
      suppressRowAnimations,
      wrappedDiffIds,
      expandedDiffIds,
      wrapToast,
      lastCopiedDiffId,
      expandedActivityIds,
      lastCopiedTurnId,
      copyGroups,
      webSearchFallbackByIndex,
      toggleDiffWrap,
      toggleDiffExpand,
      copyDiffText,
      onOpenTerminalOutputSnapshot,
      onPlanAction,
      onToggleActivity,
      onPreviewTurnImage,
      copyTurnText,
      copyGroupKeyForTurn,
    ]
  );

  return (
    <SafeAreaView className="flex-1 bg-background" edges={["top", "left", "right"]}>
      <KeyboardAvoidingView className="flex-1" behavior={Platform.OS === "ios" ? "padding" : "height"} keyboardVerticalOffset={0}>
        <View className="flex-1 bg-background px-4 pt-1">
          <ThreadHeader
            headerTitle={headerTitle}
            headerPath={headerPath}
            indicatorVisible={indicatorVisible}
            streamDotColor={streamDotColor}
            streamStatusText={streamStatus.text}
            onBackPress={() => router.back()}
          />
        {/* <Text className="mb-2 text-[11px] font-semibold uppercase tracking-[1.2px] text-muted-foreground">ID</Text>
        <Text className="mb-3 rounded-xl border border-border/10 bg-muted px-3 py-2 text-xs text-muted-foreground">{threadId}</Text> */}

        <View className="mb-3 rounded-lg border border-border/10 bg-card px-3 py-2">
          {threadGoal ? (
            <>
              <View className="flex-row items-start gap-2">
                <View className="mt-0.5 h-8 w-8 items-center justify-center rounded-full bg-muted">
                  <Ionicons name="flag-outline" size={16} color="#e5e7eb" />
                </View>
                <View className="min-w-0 flex-1">
                  <View className="mb-1 flex-row items-center gap-2">
                    <Text className="text-[11px] font-semibold uppercase tracking-[0.8px] text-muted-foreground">Goal</Text>
                    <Text className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-foreground">
                      {THREAD_GOAL_STATUS_LABELS[threadGoal.status]}
                    </Text>
                  </View>
                  <Text className="text-sm font-medium leading-5 text-foreground" numberOfLines={3}>
                    {threadGoal.objective}
                  </Text>
                  <Text className="mt-1 text-[11px] text-muted-foreground">
                    {formatGoalTokens(threadGoal)} / {formatGoalDuration(threadGoal.timeUsedSeconds)}
                  </Text>
                </View>
                <Pressable
                  onPress={() => {
                    void onClearThreadGoal();
                  }}
                  disabled={goalPending}
                  className="h-8 w-8 items-center justify-center rounded-full"
                >
                  <Ionicons name={goalPending ? "time-outline" : "close"} size={18} color="#94a3b8" />
                </Pressable>
              </View>
              {goalError ? <Text className="mt-2 text-xs text-destructive-foreground">{goalError}</Text> : null}
            </>
          ) : (
            <>
              <View className="flex-row items-center gap-2">
                <View className="h-8 w-8 items-center justify-center rounded-full bg-muted">
                  <Ionicons name="flag-outline" size={16} color="#94a3b8" />
                </View>
                <TextInput
                  value={goalDraft}
                  onChangeText={setGoalDraft}
                  placeholder="Set thread goal"
                  placeholderTextColor="#64748b"
                  className="min-w-0 flex-1 py-1 text-sm text-foreground"
                  returnKeyType="done"
                  onSubmitEditing={() => {
                    void onSetThreadGoal();
                  }}
                />
                <Pressable
                  onPress={() => {
                    void onSetThreadGoal();
                  }}
                  disabled={goalPending || goalDraft.trim().length === 0}
                  className={`h-8 w-8 items-center justify-center rounded-full ${
                    goalDraft.trim().length > 0 ? "bg-foreground" : "bg-muted"
                  }`}
                >
                  <Ionicons name={goalPending ? "time-outline" : "arrow-forward"} size={16} color={goalDraft.trim().length > 0 ? "#020617" : "#64748b"} />
                </Pressable>
              </View>
              {goalError ? <Text className="mt-2 text-xs text-destructive-foreground">{goalError}</Text> : null}
            </>
          )}
        </View>

        {error ? (
          <View className="mb-3 rounded-xl border border-border/10 bg-destructive/15 p-3">
            <Text className="text-sm text-destructive-foreground">{error}</Text>
          </View>
        ) : null}

          <ThreadTimeline
            listRef={listRef}
            turns={turns}
            loading={loading}
            renderTurnItem={renderTurnItem}
            onListScroll={onListScroll}
            onListScrollToTop={onListScrollToTop}
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
              scheduleAutoFollow(isLiveStreamingActive);
            }}
            footer={
              <LiveFooter
                liveFooterTurns={liveFooterTurns}
                smoothIsThinking={smoothIsThinking}
                threadId={threadId ?? null}
                imageProxyConfig={imageProxyConfig}
                latestUserPromptFallback={latestUserPromptFallback}
                onOpenLiveTerminalOutput={onOpenLiveTerminalOutput}
                onPlanAction={onPlanAction}
              />
            }
          />

          <View
            onLayout={(event: LayoutChangeEvent) => {
              const nextHeight = event.nativeEvent.layout.height;
              setComposerHeight((current) => (Math.abs(current - nextHeight) > 1 ? nextHeight : current));
            }}
          >
            <ThreadComposer
              activeRequestUserInput={activeRequestUserInput}
              pendingRequestUserInputs={pendingRequestUserInputs}
              activeRequestExpiryLabel={activeRequestExpiryLabel}
              activeRequestQuestion={activeRequestQuestion}
              activeRequestSelections={activeRequestSelections}
              activeRequestText={activeRequestText}
              activeRequestQuestionIndex={activeRequestQuestionIndex}
              activeRequestError={activeRequestError}
              activeRequestSubmitting={activeRequestSubmitting}
              onToggleRequestQuestionOption={toggleRequestQuestionOption}
              onSetRequestQuestionText={setRequestQuestionText}
              onBackRequestQuestion={onBackRequestQuestion}
              onAdvanceRequestQuestion={onAdvanceRequestQuestion}
              onSubmitRequestUserInput={(request) => {
                void submitRequestUserInput(request);
              }}
              queuedMessages={queuedMessages}
              queueActionPendingIds={queueActionPendingIds}
              queueErrorsById={queueErrorsById}
              sending={sending}
              onSteerQueuedMessage={(messageId) => {
                void onSteerQueuedMessage(messageId);
              }}
              onRemoveQueuedMessage={(messageId) => {
                void onRemoveQueuedMessage(messageId);
              }}
              optionsLoaded={optionsLoaded}
              resolvedSelectedModel={resolvedSelectedModel}
              currentReasoningOptions={currentReasoningOptions}
              modelOptions={modelOptions}
              resolvedSelectedReasoning={resolvedSelectedReasoning}
              selectedCollaborationMode={selectedCollaborationMode}
              keyboardVisible={keyboardVisible}
              onOpenModelDropdown={() => setOpenDropdown("model")}
              onOpenReasoningDropdown={() => setOpenDropdown("reasoning")}
              onToggleCollaborationMode={() => {
                const next = selectedCollaborationMode === "default" ? "plan" : "default";
                setSelectedCollaborationMode(next);
                setPlanModeToast(next === "plan" ? "Plan mode on" : "Plan mode off");
              }}
              onDismissKeyboard={() => Keyboard.dismiss()}
              showMentionSuggestions={showMentionSuggestions}
              mentionLoading={mentionLoading}
              mentionError={mentionError}
              mentionSuggestions={mentionSuggestions}
              onApplyMentionSelection={applyMentionSelection}
              pendingImages={pendingImages}
              onPreviewPendingImage={(uri) => setPreviewImageUri(uri)}
              onRemovePendingImage={(imageId) => {
                setPendingImages((existing) => existing.filter((image) => image.id !== imageId));
              }}
              onPickImages={() => {
                void onPickImages();
              }}
              composerInputRef={composerInputRef}
              composerText={composerText}
              onComposerTextChange={setComposerText}
              composerSelection={composerSelection}
              onComposerSelectionChange={setComposerSelection}
              composerActionDisabled={composerActionDisabled}
              shouldShowStopAction={shouldShowStopAction}
              responseStatusText={responseStatusText}
              onStopResponse={() => {
                void onStopResponse();
              }}
              onSend={() => {
                void onSend();
              }}
              composerActionIconName={composerActionIconName}
              stopping={stopping}
              insetsBottom={insets.bottom}
            />
          </View>

          {showScrollToBottomButton ? (
            <View
              pointerEvents="box-none"
              style={{ bottom: composerHeight + 20, zIndex: 50, elevation: 50 }}
              className="absolute inset-x-0 items-center"
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Go to bottom"
                onPress={onScrollToBottom}
                className="flex-row items-center gap-2 rounded-full border border-border/20 bg-card/95 px-4 py-2.5"
              >
                <Ionicons name="arrow-down" size={16} color="#f5f5f5" />
                <Text className="text-sm font-medium text-foreground">Go to bottom</Text>
              </Pressable>
            </View>
          ) : null}
      </View>
      </KeyboardAvoidingView>

      <OptionPickerModal
        openDropdown={openDropdown}
        optionsLoaded={optionsLoaded}
        insetsBottom={insets.bottom}
        modelOptions={modelOptions}
        currentReasoningOptions={currentReasoningOptions}
        resolvedSelectedModel={resolvedSelectedModel}
        resolvedSelectedReasoning={resolvedSelectedReasoning}
        onClose={() => setOpenDropdown(null)}
        onSelectModel={(value) => setSelectedModel(value)}
        onSelectReasoning={(value) => setSelectedReasoning(value)}
      />

      <TerminalOutputModal
        terminalOutput={terminalOutputForModal}
        outputComplete={
          activeTerminalView?.mode === "snapshot" ||
          (activeTerminalView?.mode === "live"
            ? liveSnapshot.terminalOutputComplete || !isLiveStreamingActive
            : !isLiveStreamingActive)
        }
        insetsTop={insets.top}
        insetsBottom={insets.bottom}
        onClose={() => setActiveTerminalView(null)}
      />

      <ImagePreviewModal
        previewImageUri={previewImageUri}
        insetsTop={insets.top}
        insetsBottom={insets.bottom}
        onClose={() => setPreviewImageUri(null)}
      />
    </SafeAreaView>
  );
}
