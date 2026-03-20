import { Text, View } from "react-native";
import { AnimatePresence, MotiView } from "moti";

interface PlanModeToastProps {
  visibleText: string | null;
}

export function PlanModeToast({ visibleText }: PlanModeToastProps) {
  return (
    <AnimatePresence>
      {visibleText !== null && (
        <MotiView
          from={{ opacity: 0, translateY: 20 }}
          animate={{ opacity: 1, translateY: 0 }}
          exit={{ opacity: 0, translateY: 20 }}
          transition={{ type: "timing", duration: 200 }}
          className="items-center"
          pointerEvents="none"
        >
          <View className="rounded-full bg-muted px-4 py-2 border border-border/10">
            <Text className="text-sm font-medium text-foreground">{visibleText}</Text>
          </View>
        </MotiView>
      )}
    </AnimatePresence>
  );
}
