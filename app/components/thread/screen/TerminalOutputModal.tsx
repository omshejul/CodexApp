import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

interface TerminalOutputModalProps {
  activeTerminalOutput: string | null;
  insetsTop: number;
  insetsBottom: number;
  onClose: () => void;
}

export function TerminalOutputModal({
  activeTerminalOutput,
  insetsTop,
  insetsBottom,
  onClose,
}: TerminalOutputModalProps) {
  return (
    <Modal transparent visible={activeTerminalOutput !== null} animationType="fade" onRequestClose={onClose}>
      <Pressable
        className="flex-1 bg-black/90 px-4"
        style={{
          paddingTop: Math.max(insetsTop, 8) + 8,
          paddingBottom: Math.max(insetsBottom, 8) + 8,
        }}
        onPress={onClose}
      >
        <Pressable
          className="flex-1 rounded-2xl border border-border/30 bg-background/95"
          onPress={(event) => {
            event.stopPropagation();
          }}
        >
          <View className="flex-row items-center justify-between border-b border-border/20 px-4 py-3">
            <Text className="text-xs font-semibold uppercase tracking-[0.8px] text-muted-foreground">Terminal Output</Text>
            <Pressable onPress={onClose} className="h-8 w-8 items-center justify-center rounded-full bg-black/25">
              <Ionicons name="close" size={18} color="#cbd5e1" />
            </Pressable>
          </View>
          <ScrollView className="flex-1" contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 12 }}>
            <Text selectable className="font-mono text-[12px] leading-5 text-foreground">
              {activeTerminalOutput ?? ""}
            </Text>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
