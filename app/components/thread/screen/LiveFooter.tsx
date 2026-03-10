import { Text, View } from "react-native";
import { AnimatePresence } from "moti";
import Markdown from "react-native-markdown-display";
import {
  formatReasoningDetail,
  markdownStyles,
  rewriteLocalMarkdownImagePaths,
  sanitizeAssistantDisplayText,
  selectableMarkdownRules,
  TerminalOutputPreviewCard,
  ThinkingShinyPill,
  type ThreadImageProxyConfig,
} from "@/components/thread/thread-renderers";
import { type RenderedTurn } from "@/lib/turns";

interface LiveFooterProps {
  liveFooterTurns: RenderedTurn[];
  smoothIsThinking: boolean;
  threadId: string | null;
  imageProxyConfig: ThreadImageProxyConfig | null;
  latestUserPromptFallback: string | null;
  onOpenTerminalOutput: (detail: string) => void;
}

export function LiveFooter({
  liveFooterTurns,
  smoothIsThinking,
  threadId,
  imageProxyConfig,
  latestUserPromptFallback,
  onOpenTerminalOutput,
}: LiveFooterProps) {
  return (
    <View>
      {liveFooterTurns.map((item, index) => (
        <View key={`footer-${item.id}-${index}`} className="mb-2 w-full items-start">
          {item.kind === "activity" && item.activity ? (
            (() => {
              if (item.activity.title === "Terminal output" && item.activity.detail) {
                const terminalDetail = item.activity.detail;
                return <TerminalOutputPreviewCard detail={terminalDetail} onPress={() => onOpenTerminalOutput(terminalDetail)} />;
              }

              if (
                item.activity.title === "Reasoning" ||
                item.activity.title === "Plan" ||
                item.activity.title === "File changes" ||
                item.activity.title === "Tool progress" ||
                item.activity.title.startsWith("Web search")
              ) {
                const webSearchFallback =
                  item.activity.title.startsWith("Web search") && !item.activity.detail
                    ? latestUserPromptFallback
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

              return (
                <View className="w-full py-1">
                  <Text className="text-center text-base font-medium text-muted-foreground">{item.activity.title}</Text>
                  {item.activity.detail ? (
                    <Text className="mt-0.5 text-center text-sm text-muted-foreground" numberOfLines={1}>
                      {item.activity.detail}
                    </Text>
                  ) : null}
                </View>
              );
            })()
          ) : item.role === "assistant" ? (
            (() => {
              const footerAssistantText = sanitizeAssistantDisplayText(item.text ?? "");
              const footerDisplayText = rewriteLocalMarkdownImagePaths(
                footerAssistantText,
                threadId,
                imageProxyConfig
              );
              return (
                <View className="w-full px-1 py-1">
                  {footerDisplayText.length > 0 ? (
                    <Markdown style={markdownStyles} rules={selectableMarkdownRules}>
                      {footerDisplayText}
                    </Markdown>
                  ) : null}
                </View>
              );
            })()
          ) : null}
        </View>
      ))}
      <AnimatePresence>{smoothIsThinking ? <ThinkingShinyPill key="thinking" /> : null}</AnimatePresence>
    </View>
  );
}
