import { type RenderedTurn } from "@/lib/turns";

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type CollaborationMode = "default" | "plan";

export interface ModelOption {
  label: string;
  value: string;
}

export interface ReasoningOption {
  label: string;
  value: ReasoningEffort;
}

export interface PendingImage {
  id: string;
  uri: string;
  imageUrl: string;
}

export interface ComposerSelection {
  start: number;
  end: number;
}

export interface MentionToken {
  start: number;
  end: number;
  query: string;
}

export interface RequestUserInputOption {
  label: string;
  description: string;
}

export interface RequestUserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: RequestUserInputOption[] | null;
}

export interface PendingRequestUserInput {
  id: string;
  threadId: string | null;
  turnId: string | null;
  createdAtMs: number;
  expiresAtMs: number;
  questions: RequestUserInputQuestion[];
}

export interface ThreadComposerPreferences {
  model: string | null;
  reasoning: ReasoningEffort | null;
  collaborationMode: CollaborationMode;
}

export type OpenDropdown = "model" | "reasoning" | null;
export type StreamStatusTone = "ok" | "warn" | "error";
export type LiveStreamBucket =
  | "assistant"
  | "terminalOutput"
  | "reasoning"
  | "plan"
  | "fileChanges"
  | "toolProgress";

export interface LiveStreamState {
  assistant: string;
  terminalOutput: string;
  reasoning: string;
  plan: string;
  fileChanges: string;
  toolProgress: string;
}

export const DEFAULT_REASONING_OPTIONS: ReasoningOption[] = [
  { label: "Minimal", value: "minimal" },
  { label: "Low", value: "low" },
  { label: "Medium", value: "medium" },
  { label: "High", value: "high" },
];

export const INTERACTIVE_REQUEST_USER_INPUT_METHOD = "item/tool/requestuserinput";
export const STREAM_METHOD_INTERACTIVE_REQUESTED = "gateway/interactive/requested";
export const STREAM_METHOD_INTERACTIVE_RESPONDED = "gateway/interactive/responded";
export const STREAM_METHOD_INTERACTIVE_EXPIRED = "gateway/interactive/expired";
export const STREAM_METHOD_QUEUE_ENQUEUED = "gateway/queue/enqueued";
export const STREAM_METHOD_QUEUE_REMOVED = "gateway/queue/removed";
export const STREAM_METHOD_QUEUE_DISPATCHED = "gateway/queue/dispatched";
export const STREAM_METHOD_QUEUE_DISPATCH_FAILED = "gateway/queue/dispatch_failed";
export const TERMINAL_TURN_METHODS = new Set(["turn/completed", "turn/failed", "turn/cancelled"]);

export const LIVE_STREAM_UI_DEBOUNCE_SECONDS = 0.35;
export const LIVE_FLUSH_INTERVAL_MS = Math.round(LIVE_STREAM_UI_DEBOUNCE_SECONDS * 1000);
export const AUTO_FOLLOW_THROTTLE_MS = 90;
export const STREAM_TURN_APPEND_BATCH_MS = 90;

export interface CodexSseEvent {
  method: string;
  params: unknown;
}

export interface ThreadChangeSummaryCache {
  byThreadKey: Map<string, RenderedTurn[]>;
}
