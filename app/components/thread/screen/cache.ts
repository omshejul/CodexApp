import { type RenderedTurn } from "@/lib/turns";
import { type ThreadComposerPreferences } from "@/components/thread/screen/types";

export const threadComposerPreferencesByThreadId = new Map<string, ThreadComposerPreferences>();
export const transientChangeSummariesByThreadKey = new Map<string, RenderedTurn[]>();
export const MAX_TRANSIENT_CHANGE_SUMMARY_THREADS = 80;
