import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { router } from "expo-router";
import { MotiView } from "moti";
import { SafeAreaView } from "react-native-safe-area-context";
import { clearSession, createThread, getThreads, ReauthRequiredError } from "@/lib/api";

interface ThreadItem {
  id: string;
  name?: string;
  title?: string;
  updatedAt?: string;
}

export default function ThreadsScreen() {
  const [threads, setThreads] = useState<ThreadItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadThreads = useCallback(async () => {
    setError(null);
    try {
      const response = await getThreads();
      setThreads(response.threads);
    } catch (loadError) {
      if (loadError instanceof ReauthRequiredError) {
        await clearSession();
        router.replace("/pair");
        return;
      }
      setError(loadError instanceof Error ? loadError.message : "Unable to load threads");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadThreads().catch(() => {
      setError("Unable to load threads");
      setLoading(false);
    });
  }, [loadThreads]);

  const onRefresh = () => {
    setRefreshing(true);
    loadThreads().catch(() => {
      setRefreshing(false);
    });
  };

  const onCreateThread = async () => {
    if (creating) {
      return;
    }
    setError(null);
    setCreating(true);
    try {
      const created = await createThread();
      router.push(`/thread/${created.threadId}`);
    } catch (createError) {
      if (createError instanceof ReauthRequiredError) {
        await clearSession();
        router.replace("/pair");
        return;
      }
      setError(createError instanceof Error ? createError.message : "Unable to create thread");
    } finally {
      setCreating(false);
    }
  };

  const renderItem = ({ item, index }: { item: ThreadItem; index: number }) => (
    <MotiView
      from={{ opacity: 0, translateY: 8 }}
      animate={{ opacity: 1, translateY: 0 }}
      transition={{ type: "timing", delay: index * 35, duration: 240 }}
      className="mb-3"
    >
      <Pressable
        onPress={() => router.push(`/thread/${item.id}`)}
        className="rounded-2xl border border-border/50 bg-card px-4 py-4"
      >
        <Text className="text-base font-bold text-card-foreground">{item.name || item.title || item.id}</Text>
        <Text className="mt-1 text-xs text-muted-foreground">
          {item.updatedAt ? new Date(item.updatedAt).toLocaleString() : "Unknown update time"}
        </Text>
      </Pressable>
    </MotiView>
  );

  return (
    <SafeAreaView className="flex-1 bg-background px-4 pt-2" edges={["top", "left", "right"]}>
      <View className="mb-4 flex-row items-center justify-between">
        <Text className="text-3xl font-semibold text-foreground">Threads</Text>
        <View className="flex-row gap-2">
          <Pressable
            className="rounded-lg border border-border/50 bg-primary px-3 py-2"
            onPress={onCreateThread}
            disabled={creating}
          >
            <Text className="text-xs font-semibold text-primary-foreground">{creating ? "Creating..." : "New Chat"}</Text>
          </Pressable>
          <Pressable
            className="rounded-lg border border-border/50 bg-muted px-3 py-2"
            onPress={async () => {
              await clearSession();
              router.replace("/pair");
            }}
          >
            <Text className="text-xs font-semibold text-foreground">Re-pair</Text>
          </Pressable>
        </View>
      </View>

      {error ? (
        <View className="mb-4 rounded-xl border border-border/50 bg-destructive/15 p-3">
          <Text className="text-sm text-destructive-foreground">{error}</Text>
        </View>
      ) : null}

      <FlatList
        data={threads}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        contentContainerStyle={{ paddingBottom: 24 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#2f7de1" />}
        ListFooterComponent={
          loading || refreshing ? (
            <View className="items-center py-4">
              <ActivityIndicator size="small" color="#22c55e" />
            </View>
          ) : null
        }
        ListEmptyComponent={
          !loading ? (
            <View className="rounded-2xl border border-dashed border-border/50 bg-muted p-6">
              <Text className="text-center text-sm text-muted-foreground">No threads returned by the gateway.</Text>
            </View>
          ) : null
        }
      />
    </SafeAreaView>
  );
}
