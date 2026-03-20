import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Image, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { AnimatePresence, MotiView } from "moti";
import { Ionicons } from "@expo/vector-icons";
import Markdown, { RenderRules } from "react-native-markdown-display";
import { JETBRAINS_MONO_REGULAR } from "@/lib/fonts";
import { RenderedTurn } from "@/lib/turns";

export interface ThreadImageProxyConfig {
  baseUrl: string;
  accessToken: string;
}

const DIRECTIVE_LINE_PATTERN = /^::[a-z][a-z0-9-]*\{.*\}\s*$/i;
const TERMINAL_PREVIEW_MAX_LINES = 6;

const SYSTEM_FONT = Platform.select({
  ios: "System",
  android: "sans-serif",
  default: "System",
});

const MONO_FONT = JETBRAINS_MONO_REGULAR;

export const markdownStyles = {
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

function isSupportedMarkdownImageUri(uri: string): boolean {
  const normalized = uri.trim().toLowerCase();
  return (
    normalized.startsWith("https://") ||
    normalized.startsWith("http://") ||
    normalized.startsWith("data:image/") ||
    normalized.startsWith("file://")
  );
}

export function rewriteLocalMarkdownImagePaths(
  text: string,
  threadId: string | null,
  imageProxyConfig: ThreadImageProxyConfig | null
): string {
  if (!threadId || !imageProxyConfig) {
    return text;
  }

  const replacementBase = `${imageProxyConfig.baseUrl}/threads/${encodeURIComponent(threadId)}/local-image`;
  return text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (match, altText, sourceUrl) => {
    if (typeof sourceUrl !== "string") {
      return match;
    }

    const normalizedSource = sourceUrl.trim();
    if (!normalizedSource.startsWith("/")) {
      return match;
    }
    if (
      !normalizedSource.startsWith("/Users/") &&
      !normalizedSource.startsWith("/private/") &&
      !normalizedSource.startsWith("/var/")
    ) {
      return match;
    }

    const replacementUrl = `${replacementBase}?path=${encodeURIComponent(normalizedSource)}&access_token=${encodeURIComponent(
      imageProxyConfig.accessToken
    )}`;
    const safeAltText = typeof altText === "string" ? altText : "";
    return `![${safeAltText}](${replacementUrl})`;
  });
}

export const selectableMarkdownRules: RenderRules = {
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
        <Text style={[inheritedStyles, textStyle]}>{content}</Text>
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
        <Text style={[inheritedStyles, textStyle]}>{content}</Text>
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
  image: (node, _children, _parent, styles) => {
    const src = typeof node.attributes?.src === "string" ? node.attributes.src.trim() : "";
    const alt = typeof node.attributes?.alt === "string" ? node.attributes.alt.trim() : "Image";

    if (!src) {
      return null;
    }

    if (!isSupportedMarkdownImageUri(src)) {
      return (
        <Text key={node.key} selectable style={styles.link}>
          {alt}
        </Text>
      );
    }

    return (
      <Image
        key={node.key}
        source={{ uri: src }}
        resizeMode="contain"
        style={{
          width: "100%",
          height: 220,
          borderRadius: 12,
          marginTop: 4,
          marginBottom: 10,
          backgroundColor: "rgba(0,0,0,0.25)",
        }}
      />
    );
  },
};

export function formatReasoningDetail(detail: string): string {
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

export function useSmoothedFlag(value: boolean, exitDelayMs = 180): boolean {
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

interface PlanActivityCardProps {
  detail: string;
  onImplementPlan: () => void;
  onRevisePlan: () => void;
}

export function PlanActivityCard({ detail, onImplementPlan, onRevisePlan }: PlanActivityCardProps) {
  return (
    <View className="w-full rounded-2xl border border-border/20 bg-black/35 px-3 py-3">
      <Text className="mb-2 text-xs font-semibold uppercase tracking-[0.8px] text-muted-foreground">Plan</Text>
      <Markdown style={markdownStyles} rules={selectableMarkdownRules}>
        {detail}
      </Markdown>
      <View className="mt-2 flex-row gap-2">
        <Pressable onPress={onImplementPlan} className="h-9 flex-1 items-center justify-center rounded-xl bg-foreground">
          <Text className="text-xs font-semibold text-background">Implement</Text>
        </Pressable>
        <Pressable
          onPress={onRevisePlan}
          className="h-9 flex-1 items-center justify-center rounded-xl border border-border/40 bg-black/20"
        >
          <Text className="text-xs font-semibold text-foreground">Revise</Text>
        </Pressable>
      </View>
    </View>
  );
}

export function sanitizeAssistantDisplayText(text: string): string {
  return text
    .split("\n")
    .filter((line) => !DIRECTIVE_LINE_PATTERN.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function diffLineToneClassName(line: string): string {
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
}

function buildDisplayDiffLines(diff: string): Array<{ lineNumber: number | null; line: string; tone: string }> {
  const rawLines = diff.split("\n");
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
}

function buildTerminalOutputPreview(
  detail: string,
  maxLines: number
): { lines: Array<{ lineNumber: number; line: string; tone: string }>; hiddenLineCount: number } {
  const normalized = detail.replace(/\r/g, "").split("\n");
  const totalLines = normalized.length;
  const startIndex = Math.max(0, totalLines - maxLines);
  const visible = normalized.slice(startIndex);

  return {
    lines: visible.map((line, idx) => ({
      lineNumber: startIndex + idx + 1,
      line: line.length > 0 ? line : " ",
      tone: diffLineToneClassName(line),
    })),
    hiddenLineCount: Math.max(0, startIndex),
  };
}

interface TerminalOutputPreviewCardProps {
  detail: string;
  onPress: () => void;
}

export function TerminalOutputPreviewCard({ detail, onPress }: TerminalOutputPreviewCardProps) {
  const preview = useMemo(
    () => buildTerminalOutputPreview(detail, TERMINAL_PREVIEW_MAX_LINES),
    [detail]
  );

  return (
    <Pressable className="w-full rounded-xl border border-border/20 bg-black/35 px-3 py-2" onPress={onPress}>
      <View className="mb-1 flex-row items-center justify-between">
        <Text className="text-xs font-semibold uppercase tracking-[0.8px] text-muted-foreground">Terminal output</Text>
        <View className="flex-row items-center gap-1">
          <Text className="text-[11px] text-muted-foreground">Open</Text>
          <Ionicons name="expand-outline" size={12} color="#94a3b8" />
        </View>
      </View>

      <View className="rounded-lg border border-border/20 bg-black/35 px-2 py-1.5">
        {preview.hiddenLineCount > 0 ? (
          <Text className="mb-1 text-[10px] text-muted-foreground">… {preview.hiddenLineCount} earlier line(s)</Text>
        ) : null}
        <ScrollView horizontal showsHorizontalScrollIndicator>
          <View className="pr-2">
            {preview.lines.map((line) => (
              <View key={`terminal-preview-line-${line.lineNumber}`} className="flex-row items-start">
                <Text className="w-9 pr-2 text-right text-[10px] leading-5 text-slate-500">{line.lineNumber}</Text>
                <Text className={`text-[12px] leading-5 ${line.tone}`} style={{ fontFamily: MONO_FONT }}>
                  {line.line}
                </Text>
              </View>
            ))}
          </View>
        </ScrollView>
      </View>
    </Pressable>
  );
}

export interface CopyGroups {
  lastIndexByKey: Map<string, number>;
  textByKey: Map<string, string>;
}

export interface ThreadTurnRowProps {
  item: RenderedTurn;
  index: number;
  threadId: string | null;
  imageProxyConfig: ThreadImageProxyConfig | null;
  isLiveStreamingActive: boolean;
  suppressRowAnimations: boolean;
  wrappedDiffIds: Set<string>;
  expandedDiffIds: Set<string>;
  wrapToast: { diffId: string; wrapped: boolean } | null;
  lastCopiedDiffId: string | null;
  expandedActivityIds: Set<string>;
  lastCopiedTurnId: string | null;
  copyGroups: CopyGroups;
  webSearchFallback: string | null;
  onToggleDiffWrap: (diffId: string) => void;
  onToggleDiffExpand: (diffId: string) => void;
  onCopyDiffText: (diffId: string, diffText?: string) => void;
  onOpenTerminalOutput: (detail: string) => void;
  onPlanAction: (action: "implement" | "revise", detail: string) => void;
  onToggleActivity: (turnId: string) => void;
  onPreviewImage: (uri: string) => void;
  onCopyTurnText: (turnId: string, text?: string) => void;
  copyGroupKeyForTurn: (turn: RenderedTurn) => string;
}

function areThreadTurnRowPropsEqual(previous: ThreadTurnRowProps, next: ThreadTurnRowProps): boolean {
  return (
    previous.item === next.item &&
    previous.index === next.index &&
    previous.threadId === next.threadId &&
    previous.imageProxyConfig === next.imageProxyConfig &&
    previous.isLiveStreamingActive === next.isLiveStreamingActive &&
    previous.suppressRowAnimations === next.suppressRowAnimations &&
    previous.wrappedDiffIds === next.wrappedDiffIds &&
    previous.expandedDiffIds === next.expandedDiffIds &&
    previous.wrapToast === next.wrapToast &&
    previous.lastCopiedDiffId === next.lastCopiedDiffId &&
    previous.expandedActivityIds === next.expandedActivityIds &&
    previous.lastCopiedTurnId === next.lastCopiedTurnId &&
    previous.copyGroups === next.copyGroups &&
    previous.webSearchFallback === next.webSearchFallback &&
    previous.onToggleDiffWrap === next.onToggleDiffWrap &&
    previous.onCopyDiffText === next.onCopyDiffText &&
    previous.onOpenTerminalOutput === next.onOpenTerminalOutput &&
    previous.onPlanAction === next.onPlanAction &&
    previous.onToggleActivity === next.onToggleActivity &&
    previous.onPreviewImage === next.onPreviewImage &&
    previous.onCopyTurnText === next.onCopyTurnText &&
    previous.copyGroupKeyForTurn === next.copyGroupKeyForTurn
  );
}

export const ThreadTurnRow = memo(function ThreadTurnRow({
  item,
  index,
  threadId,
  imageProxyConfig,
  isLiveStreamingActive,
  suppressRowAnimations,
  wrappedDiffIds,
  expandedDiffIds,
  wrapToast,
  lastCopiedDiffId,
  expandedActivityIds,
  lastCopiedTurnId,
  copyGroups,
  webSearchFallback,
  onToggleDiffWrap,
  onCopyDiffText,
  onOpenTerminalOutput,
  onPlanAction,
  onToggleDiffExpand,
  onToggleActivity,
  onPreviewImage,
  onCopyTurnText,
  copyGroupKeyForTurn,
}: ThreadTurnRowProps) {
  const assistantDisplayText = useMemo(
    () => rewriteLocalMarkdownImagePaths(sanitizeAssistantDisplayText(item.text ?? ""), threadId, imageProxyConfig),
    [imageProxyConfig, item.text, threadId]
  );

  const diffLinesByDiffId = useMemo(() => {
    const next = new Map<string, Array<{ lineNumber: number | null; line: string; tone: string }>>();
    if (item.kind !== "changeSummary" || !item.summary) {
      return next;
    }

    for (const file of item.summary.files) {
      if (typeof file.diff === "string" && file.diff.length > 0) {
        const diffId = `${item.id}:${file.path}`;
        next.set(diffId, buildDisplayDiffLines(file.diff));
      }
    }
    return next;
  }, [item]);

  return (
    <MotiView
      from={isLiveStreamingActive || suppressRowAnimations ? { opacity: 1, translateY: 0 } : { opacity: 0, translateY: 6 }}
      animate={{ opacity: 1, translateY: 0 }}
      transition={
        isLiveStreamingActive || suppressRowAnimations
          ? { type: "timing", duration: 0 }
          : { type: "timing", delay: Math.min(index, 8) * 18, duration: 160 }
      }
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
            const isExpanded = expandedDiffIds.has(diffId);
            const isWrapped = wrappedDiffIds.has(diffId);
            const diffLines = diffLinesByDiffId.get(diffId) ?? [];
            return (
              <View key={`${item.id}-${file.path}`} className="mt-2">
                <Pressable
                  onPress={() => onToggleDiffExpand(diffId)}
                  className="flex-row items-center justify-between rounded-xl border border-border/20 bg-black/20 px-3 py-2.5"
                >
                  <View className="max-w-[74%] flex-row items-center gap-2">
                    <Ionicons
                      name={isExpanded ? "chevron-down" : "chevron-forward"}
                      size={14}
                      color="#cbd5e1"
                    />
                    <Text className="flex-shrink text-xs leading-5 text-foreground">{file.path}</Text>
                  </View>
                  <Text className="text-lg font-semibold">
                    <Text className="text-emerald-400">+{file.additions}</Text>
                    <Text className="text-red-400"> -{file.deletions}</Text>
                  </Text>
                </Pressable>
                {isExpanded && typeof file.diff === "string" && file.diff.length > 0 ? (
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
                              className="absolute -top-0 right-full z-20 mr-0.5 w-[100px] items-center rounded-full bg-black/20 px-2.5 py-2"
                            >
                              <Text className="text-sm text-primary-foreground">
                                Word wrap {wrapToast.wrapped ? "ON" : "OFF"}
                              </Text>
                            </MotiView>
                          ) : null}
                        </AnimatePresence>
                        <Pressable
                          onPress={() => onToggleDiffWrap(diffId)}
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
                        onPress={() => onCopyDiffText(diffId, file.diff)}
                        className="flex-row items-center justify-center rounded-full bg-black/20 px-2.5 py-2.5"
                      >
                        <Ionicons
                          name={lastCopiedDiffId === diffId ? "checkmark" : "copy-outline"}
                          size={12}
                          className="text-primary-foreground"
                        />
                      </Pressable>
                    </View>
                    {isWrapped ? (
                      <View className="pr-2">
                        {diffLines.map(({ lineNumber, line, tone }, lineIndex) => (
                          <View key={`${item.id}-${file.path}-line-row-${lineIndex}`} className="flex-row items-start">
                            <Text className="w-9 pr-2 text-right text-[10px] leading-5 text-slate-500">
                              {lineNumber ?? ""}
                            </Text>
                            <Text className={`flex-1 text-[12px] leading-5 ${tone}`} style={{ fontFamily: MONO_FONT, fontWeight: "600" }}>
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
                              <Text className={`text-[12px] leading-5 ${tone}`} style={{ fontFamily: MONO_FONT, fontWeight: "600" }}>
                                {line.length > 0 ? line : " "}
                              </Text>
                            </View>
                          ))}
                        </View>
                      </ScrollView>
                    )}
                  </View>
                ) : null}
              </View>
            );
          })}
        </View>
      ) : item.kind === "activity" && item.activity ? (
        (() => {
          if (item.activity.title === "Terminal output" && item.activity.detail) {
            const terminalDetail = item.activity.detail;
            return <TerminalOutputPreviewCard detail={terminalDetail} onPress={() => onOpenTerminalOutput(terminalDetail)} />;
          }

          if (item.activity.title === "Plan" && item.activity.detail) {
            const planDetail = item.activity.detail;
            return (
              <PlanActivityCard
                detail={planDetail}
                onImplementPlan={() => onPlanAction("implement", planDetail)}
                onRevisePlan={() => onPlanAction("revise", planDetail)}
              />
            );
          }

          if (
            item.activity.title === "Reasoning" ||
            item.activity.title === "File changes" ||
            item.activity.title === "Tool progress" ||
            item.activity.title.startsWith("Web search")
          ) {
            const shouldUseWebSearchFallback = item.activity.title.startsWith("Web search") && !item.activity.detail;
            const activityDetail =
              item.activity.title === "Reasoning"
                ? formatReasoningDetail(item.activity.detail ?? "")
                : item.activity.detail ??
                  (shouldUseWebSearchFallback && webSearchFallback ? `From prompt: ${webSearchFallback}` : "");
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
              <Pressable className="w-full py-1" onPress={() => onToggleActivity(item.id)}>
                <Text className="text-center text-base font-medium text-muted-foreground">{item.activity.title}</Text>
                {expandedActivityIds.has(item.id) ? (
                  <View className="mt-1 rounded-lg border border-border/20 bg-black/35 px-3 py-2">
                    <Text className="font-mono text-[12px] leading-5 text-foreground">{item.activity.detail}</Text>
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
              <Text className={`${isReadFileActivity ? "text-left" : "text-center"} text-base font-medium text-muted-foreground`}>
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
      ) : item.role === "user" ? (
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
                  <Pressable key={`${item.id}-user-image-${imageIndex}`} onPress={() => onPreviewImage(uri)}>
                    <Image source={{ uri }} resizeMode="contain" className="mb-2 h-48 w-64 rounded-xl bg-black/25" />
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
                  onPress={() => onCopyTurnText(copyKey, copyText)}
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
          {assistantDisplayText.length > 0 ? (
            <Markdown style={markdownStyles} rules={selectableMarkdownRules}>
              {assistantDisplayText}
            </Markdown>
          ) : null}
          {item.images?.length ? (
            <View className={assistantDisplayText.length > 0 ? "mt-1" : ""}>
              {item.images.map((uri, imageIndex) => (
                <Pressable key={`${item.id}-assistant-image-${imageIndex}`} onPress={() => onPreviewImage(uri)}>
                  <Image source={{ uri }} resizeMode="contain" className="mb-2 h-52 w-full rounded-xl bg-black/25" />
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
                  onPress={() => onCopyTurnText(copyKey, copyText)}
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
      )}
    </MotiView>
  );
}, areThreadTurnRowPropsEqual);

export function extractApiErrorMessage(body: string): string | null {
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
