import { useEffect, useMemo, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { JETBRAINS_MONO_REGULAR } from "@/lib/fonts";

const MONO_FONT = JETBRAINS_MONO_REGULAR;
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

function normalizeTerminalOutput(detail: string): string {
  return detail.replace(ANSI_ESCAPE_PATTERN, "").replace(/\r/g, "");
}

function toneClassName(line: string): string {
  if (line.startsWith("+")) {
    return "text-emerald-400";
  }
  if (line.startsWith("-")) {
    return "text-red-400";
  }
  if (line.startsWith("@@")) {
    return "text-slate-400";
  }
  return "text-slate-100";
}

interface TerminalOutputModalProps {
  terminalOutput: string | null;
  outputComplete: boolean;
  insetsTop: number;
  insetsBottom: number;
  onClose: () => void;
}

export function TerminalOutputModal({
  terminalOutput,
  outputComplete,
  insetsTop,
  insetsBottom,
  onClose,
}: TerminalOutputModalProps) {
  const scrollRef = useRef<ScrollView>(null);
  const hasOpenedRef = useRef(false);
  const followBottomRef = useRef(true);
  const [wrapOutput, setWrapOutput] = useState(true);
  const normalizedOutput = useMemo(
    () => (terminalOutput ? normalizeTerminalOutput(terminalOutput) : ""),
    [terminalOutput]
  );
  const lines = useMemo(() => normalizedOutput.split("\n"), [normalizedOutput]);
  const lineNumberDigits = useMemo(() => Math.max(2, String(Math.max(lines.length, 1)).length), [lines.length]);
  const lineNumberWidth = useMemo(() => Math.max(28, lineNumberDigits * 8 + 6), [lineNumberDigits]);

  useEffect(() => {
    if (!terminalOutput) {
      hasOpenedRef.current = false;
      followBottomRef.current = true;
      setWrapOutput(true);
      return;
    }
    if (hasOpenedRef.current) {
      return;
    }
    const timer = setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: false });
      hasOpenedRef.current = true;
    }, 0);
    return () => clearTimeout(timer);
  }, [terminalOutput]);

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceFromBottom = contentSize.height - (contentOffset.y + layoutMeasurement.height);
    followBottomRef.current = distanceFromBottom < 120;
  };

  return (
    <Modal visible={terminalOutput !== null} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <View
        className="flex-1 bg-neutral-900"
        style={{
          paddingTop: Math.max(insetsTop, 8),
          paddingBottom: Math.max(insetsBottom, 8),
        }}
      >
        <View className="flex-row items-center justify-between border-b border-neutral-700 bg-neutral-800 px-4 py-3">
          <Text className="text-xs font-semibold uppercase tracking-[1px] text-slate-300">Terminal Output</Text>
          <View className="flex-row items-center gap-2">
            <Pressable
              onPress={() => setWrapOutput((current) => !current)}
              className="rounded-full border border-neutral-600 bg-neutral-700/80 px-3 py-1.5"
            >
              <Text className="text-[11px] font-semibold uppercase tracking-[1px] text-slate-200">
                Wrap {wrapOutput ? "On" : "Off"}
              </Text>
            </Pressable>
            <Pressable onPress={onClose} className="h-8 w-8 items-center justify-center rounded-full bg-neutral-700/80">
              <Ionicons name="close" size={18} color="#e5e7eb" />
            </Pressable>
          </View>
        </View>

        {wrapOutput ? (
          <ScrollView
            ref={scrollRef}
            className="flex-1"
            contentContainerStyle={{ paddingVertical: 10, paddingHorizontal: 6 }}
            onScroll={onScroll}
            scrollEventThrottle={16}
            showsVerticalScrollIndicator
            nestedScrollEnabled
            onContentSizeChange={() => {
              if (!followBottomRef.current) {
                return;
              }
              scrollRef.current?.scrollToEnd({ animated: hasOpenedRef.current });
            }}
          >
            <View>
              {lines.map((line, index) => (
                <View key={`terminal-line-${index}`} className="flex-row items-start">
                  <Text
                    className="pr-1.5 text-right text-[10px] leading-5 text-slate-500"
                    style={{ width: lineNumberWidth, fontFamily: MONO_FONT }}
                  >
                    {index + 1}
                  </Text>
                  <Text
                    selectable
                    className={`text-[12px] leading-5 ${toneClassName(line)}`}
                    style={{ fontFamily: MONO_FONT, flex: 1 }}
                  >
                    {line.length > 0 ? line : " "}
                  </Text>
                </View>
              ))}
              {outputComplete ? (
                <View className="flex-row items-center px-1 py-4">
                  <View className="h-px flex-1 bg-neutral-700" />
                  <Text
                    className="px-3 text-[10px] font-semibold uppercase tracking-[1px] text-slate-400"
                    style={{ fontFamily: MONO_FONT }}
                  >
                    End of terminal output
                  </Text>
                  <View className="h-px flex-1 bg-neutral-700" />
                </View>
              ) : null}
            </View>
          </ScrollView>
        ) : (
          <ScrollView
            horizontal
            className="flex-1 bg-neutral-900"
            contentContainerStyle={{ minWidth: "100%", flexGrow: 1 }}
            showsHorizontalScrollIndicator
            bounces={false}
          >
            <ScrollView
              ref={scrollRef}
              className="flex-1"
              style={{ minWidth: "100%" }}
              contentContainerStyle={{ paddingVertical: 10, paddingHorizontal: 6 }}
              onScroll={onScroll}
              scrollEventThrottle={16}
              showsVerticalScrollIndicator
              nestedScrollEnabled
              onContentSizeChange={() => {
                if (!followBottomRef.current) {
                  return;
                }
                scrollRef.current?.scrollToEnd({ animated: hasOpenedRef.current });
              }}
            >
              <View>
                {lines.map((line, index) => (
                  <View key={`terminal-line-${index}`} className="flex-row items-start">
                    <Text
                      className="pr-1.5 text-right text-[10px] leading-5 text-slate-500"
                      style={{ width: lineNumberWidth, fontFamily: MONO_FONT }}
                    >
                      {index + 1}
                    </Text>
                    <Text
                      selectable
                      className={`text-[12px] leading-5 ${toneClassName(line)}`}
                      style={{ fontFamily: MONO_FONT, flexShrink: 0 }}
                    >
                      {line.length > 0 ? line : " "}
                    </Text>
                  </View>
                ))}
                {outputComplete ? (
                  <View className="flex-row items-center px-1 py-4">
                    <View className="h-px flex-1 bg-neutral-700" />
                    <Text
                      className="px-3 text-[10px] font-semibold uppercase tracking-[1px] text-slate-400"
                      style={{ fontFamily: MONO_FONT }}
                    >
                      End of terminal output
                    </Text>
                    <View className="h-px flex-1 bg-neutral-700" />
                  </View>
                ) : null}
              </View>
            </ScrollView>
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}
