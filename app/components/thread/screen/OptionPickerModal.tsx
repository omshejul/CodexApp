import { Modal, Pressable, Text } from "react-native";
import { AnimatePresence, MotiView } from "moti";
import { Ionicons } from "@expo/vector-icons";
import {
  type OpenDropdown,
  type ModelOption,
  type ReasoningEffort,
  type ReasoningOption,
} from "@/components/thread/screen/types";

interface OptionPickerModalProps {
  openDropdown: OpenDropdown;
  optionsLoaded: boolean;
  insetsBottom: number;
  modelOptions: ModelOption[];
  currentReasoningOptions: ReasoningOption[];
  resolvedSelectedModel: string | null;
  resolvedSelectedReasoning: ReasoningEffort | null;
  onClose: () => void;
  onSelectModel: (value: string) => void;
  onSelectReasoning: (value: ReasoningEffort) => void;
}

export function OptionPickerModal({
  openDropdown,
  optionsLoaded,
  insetsBottom,
  modelOptions,
  currentReasoningOptions,
  resolvedSelectedModel,
  resolvedSelectedReasoning,
  onClose,
  onSelectModel,
  onSelectReasoning,
}: OptionPickerModalProps) {
  return (
    <Modal transparent visible={openDropdown !== null && optionsLoaded} animationType="fade" onRequestClose={onClose}>
      <Pressable
        className="flex-1 justify-end bg-background/80 px-4"
        style={{ paddingBottom: Math.max(insetsBottom, 8) + 96 }}
        onPress={onClose}
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
                  const active =
                    openDropdown === "model"
                      ? resolvedSelectedModel === option.value
                      : resolvedSelectedReasoning === option.value;
                  return (
                    <Pressable
                      key={`${openDropdown}-${option.label}`}
                      className={`rounded-lg px-3 py-3 flex-row items-center justify-between ${active ? "bg-card" : "bg-transparent"}`}
                      onPress={() => {
                        if (openDropdown === "model") {
                          onSelectModel(option.value as string);
                        } else {
                          onSelectReasoning(option.value as ReasoningEffort);
                        }
                        onClose();
                      }}
                    >
                      <Text
                        className={`text-base ${active ? "font-semibold text-primary-foreground" : "text-muted-foreground"}`}
                      >
                        {option.label}
                      </Text>
                      {active ? <Ionicons name="checkmark" size={20} className="text-primary-foreground" /> : null}
                    </Pressable>
                  );
                })}
              </Pressable>
            </MotiView>
          )}
        </AnimatePresence>
      </Pressable>
    </Modal>
  );
}
