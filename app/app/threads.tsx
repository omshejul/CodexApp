import { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { router } from "expo-router";
import { MotiView } from "moti";
import { clearSession, getThreads, ReauthRequiredError } from "@/lib/api";

interface ThreadItem {
  id: string;
  title?: string;
  updatedAt?: string;
}

export default function ThreadsScreen() {
  const [threads, setThreads] = useState<ThreadItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
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

  const renderItem = ({ item, index }: { item: ThreadItem; index: number }) => (
    <MotiView
      from={{ opacity: 0, translateY: 8 }}
      animate={{ opacity: 1, translateY: 0 }}
      transition={{ type: "timing", delay: index * 35, duration: 240 }}
      className="mb-3"
    >
      <Pressable
        onPress={() => router.push(`/thread/${item.id}`)}
        className="rounded-2xl border border-[#d9ecff] bg-white px-4 py-4"
      >
        <Text className="text-base font-bold text-[#14335f]">{item.title || item.id}</Text>
        <Text className="mt-1 text-xs text-[#365f89]">{item.updatedAt ? new Date(item.updatedAt).toLocaleString() : "Unknown update time"}</Text>
      </Pressable>
    </MotiView>
  );

  return (
    <View className="flex-1 bg-[#f6f9ff] px-4 pt-4">
      <View className="mb-4 flex-row items-center justify-between">
        <Text className="text-3xl font-black text-[#14335f]">Threads</Text>
        <Pressable
          className="rounded-lg border border-[#c4ddfb] bg-white px-3 py-2"
          onPress={async () => {
            await clearSession();
            router.replace("/pair");
          }}
        >
          <Text className="text-xs font-semibold text-[#1f57a4]">Re-pair</Text>
        </Pressable>
      </View>

      {error ? (
        <View className="mb-4 rounded-xl border border-[#f1b7b7] bg-[#fff4f4] p-3">
          <Text className="text-sm text-[#a42f2f]">{error}</Text>
        </View>
      ) : null}

      <FlatList
        data={threads}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        contentContainerStyle={{ paddingBottom: 24 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#2f7de1" />}
        ListEmptyComponent={
          !loading ? (
            <View className="rounded-2xl border border-dashed border-[#c4ddfb] bg-white p-6">
              <Text className="text-center text-sm text-[#365f89]">No threads returned by the gateway.</Text>
            </View>
          ) : null
        }
      />
    </View>
  );
}
