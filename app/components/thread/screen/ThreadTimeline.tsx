import { type ReactElement, type RefObject } from "react";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Text,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ListRenderItem,
  View,
} from "react-native";
import { type RenderedTurn } from "@/lib/turns";

interface ThreadTimelineProps {
  listRef: RefObject<FlatList<RenderedTurn> | null>;
  turns: RenderedTurn[];
  loading: boolean;
  renderTurnItem: ListRenderItem<RenderedTurn>;
  onListScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onListScrollToTop: () => void;
  onScrollBeginDrag: () => void;
  onScrollEndDrag: () => void;
  onMomentumScrollEnd: () => void;
  onContentSizeChange: () => void;
  footer: ReactElement | null;
}

export function ThreadTimeline({
  listRef,
  turns,
  loading,
  renderTurnItem,
  onListScroll,
  onListScrollToTop,
  onScrollBeginDrag,
  onScrollEndDrag,
  onMomentumScrollEnd,
  onContentSizeChange,
  footer,
}: ThreadTimelineProps) {
  return (
    <FlatList
      ref={listRef}
      data={turns}
      keyExtractor={(item) => item.id}
      className="flex-1"
      style={{ marginHorizontal: -16 }}
      contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 16 }}
      indicatorStyle="white"
      scrollIndicatorInsets={{ right: 1 }}
      keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
      keyboardShouldPersistTaps="handled"
      onScroll={onListScroll}
      onScrollBeginDrag={onScrollBeginDrag}
      onScrollToTop={onListScrollToTop}
      onScrollEndDrag={onScrollEndDrag}
      onMomentumScrollEnd={onMomentumScrollEnd}
      onContentSizeChange={onContentSizeChange}
      scrollEventThrottle={16}
      renderItem={renderTurnItem}
      ListEmptyComponent={
        loading ? (
          <View className="items-center justify-center rounded-2xl border border-border/10 bg-muted p-5">
            <ActivityIndicator color="#8f8f8f" />
            <Text className="mt-2 text-sm text-muted-foreground">Loading thread…</Text>
          </View>
        ) : (
          <View className="rounded-2xl border border-dashed border-border/50 bg-card p-4">
            <Text className="text-center text-sm text-muted-foreground">No turns available for this thread yet.</Text>
          </View>
        )
      }
      ListFooterComponent={footer}
    />
  );
}
