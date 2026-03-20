import { Pressable, Text, View } from "react-native";
import { MotiView } from "moti";
import { Ionicons } from "@expo/vector-icons";
import { formatPathForDisplay } from "@/lib/path";

interface ThreadHeaderProps {
  headerTitle: string;
  headerPath: string | null;
  indicatorVisible: boolean;
  streamDotColor: string;
  streamStatusText: string;
  onBackPress: () => void;
}

export function ThreadHeader({
  headerTitle,
  headerPath,
  indicatorVisible,
  streamDotColor,
  streamStatusText,
  onBackPress,
}: ThreadHeaderProps) {
  return (
    <View className="-mx-4 mb-3 border-b border-border/50 pb-2 px-4">
      <View className="relative h-12 justify-center">
        <View className="absolute bottom-0 left-0 top-0 z-10 justify-center">
          <Pressable onPress={onBackPress} className="self-start h-10 w-10 items-center justify-center">
            <Ionicons name="chevron-back" size={24} color="#ffffff" />
          </Pressable>
        </View>

        <View className="px-12">
          <View className="items-center">
            <Text className="text-xl font-semibold text-foreground" numberOfLines={1}>
              {headerTitle}
            </Text>
            <MotiView
              animate={{ opacity: headerPath ? 1 : 0, translateY: headerPath ? 0 : -4, height: headerPath ? 16 : 0 }}
              transition={{ type: "timing", duration: 220 }}
              style={{ overflow: "hidden", width: "100%", alignItems: "center" }}
            >
              <Text className="text-[11px] leading-[14px] text-muted-foreground" numberOfLines={1}>
                {headerPath ? formatPathForDisplay(headerPath) : ""}
              </Text>
            </MotiView>
          </View>
        </View>

        <View className="absolute bottom-0 right-0 top-0 z-10 items-end justify-center">
          <MotiView
            animate={{ opacity: indicatorVisible ? 1 : 0, scale: indicatorVisible ? 1 : 0.97 }}
            transition={{ type: "timing", duration: 1000 }}
          >
            <View className="flex-row items-center rounded-full border border-border/10 bg-card px-2.5 py-1.5">
              <View className="mr-1.5 h-2 w-2 rounded-full" style={{ backgroundColor: streamDotColor }} />
              <Text className="text-xs font-semibold text-foreground">{streamStatusText}</Text>
            </View>
          </MotiView>
        </View>
      </View>
    </View>
  );
}
