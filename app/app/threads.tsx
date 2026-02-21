import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Modal, Pressable, RefreshControl, Text, View } from "react-native";
import { router } from "expo-router";
import { MotiView } from "moti";
import { SafeAreaView } from "react-native-safe-area-context";
import { clearSession, createThread, getDirectories, getThreads, ReauthRequiredError } from "@/lib/api";

interface ThreadItem {
  id: string;
  name?: string;
  title?: string;
  updatedAt?: string;
  cwd?: string;
}

function formatRelativeTime(updatedAt?: string): string {
  if (!updatedAt) {
    return "Unknown update time";
  }

  const timestamp = new Date(updatedAt).getTime();
  if (!Number.isFinite(timestamp)) {
    return "Unknown update time";
  }

  const diffSeconds = Math.round((timestamp - Date.now()) / 1000);
  const absSeconds = Math.abs(diffSeconds);
  const suffix = diffSeconds < 0 ? "ago" : "from now";

  if (absSeconds < 5) {
    return "just now";
  }

  const format = (value: number, unit: string) => `${value} ${unit}${value === 1 ? "" : "s"} ${suffix}`;
  if (absSeconds < 60) {
    return format(absSeconds, "second");
  }
  if (absSeconds < 3600) {
    return format(Math.round(absSeconds / 60), "minute");
  }
  if (absSeconds < 86400) {
    return format(Math.round(absSeconds / 3600), "hour");
  }
  if (absSeconds < 604800) {
    return format(Math.round(absSeconds / 86400), "day");
  }
  if (absSeconds < 2629800) {
    return format(Math.round(absSeconds / 604800), "week");
  }
  if (absSeconds < 31557600) {
    return format(Math.round(absSeconds / 2629800), "month");
  }
  return format(Math.round(absSeconds / 31557600), "year");
}

export default function ThreadsScreen() {
  const [threads, setThreads] = useState<ThreadItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showWorkspacePicker, setShowWorkspacePicker] = useState(false);
  const [loadingDirectories, setLoadingDirectories] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [currentDirectory, setCurrentDirectory] = useState<string | null>(null);
  const [parentDirectory, setParentDirectory] = useState<string | null>(null);
  const [folders, setFolders] = useState<Array<{ name: string; path: string }>>([]);

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

  const onCreateThread = async (cwd: string) => {
    if (creating) {
      return;
    }
    setError(null);
    setCreating(true);
    try {
      const created = await createThread({ cwd });
      router.push(`/thread/${created.threadId}`);
      setShowWorkspacePicker(false);
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

  const loadDirectory = async (pathValue?: string) => {
    if (loadingDirectories) {
      return;
    }

    setLoadingDirectories(true);
    try {
      const response = await getDirectories(pathValue);
      setCurrentDirectory(response.currentPath);
      setParentDirectory(response.parentPath);
      setFolders(response.folders);
      setPickerError(null);
    } catch (directoryError) {
      if (directoryError instanceof ReauthRequiredError) {
        await clearSession();
        router.replace("/pair");
        return;
      }
      setPickerError(directoryError instanceof Error ? directoryError.message : "Unable to load folders");
    } finally {
      setLoadingDirectories(false);
    }
  };

  const openWorkspacePicker = async () => {
    if (creating) {
      return;
    }

    setShowWorkspacePicker(true);
    setPickerError(null);
    await loadDirectory();
  };

  const onCancelPicker = () => {
    setShowWorkspacePicker(false);
    setPickerError(null);
  };

  const breadcrumb = (() => {
    if (!currentDirectory) {
      return "Loading...";
    }
    const parts = currentDirectory.split("/").filter((part) => part.length > 0);
    if (parts.length === 0) {
      return "Root";
    }
    return `Root / ${parts.join(" / ")}`;
  })();

  const renderItem = ({ item, index }: { item: ThreadItem; index: number }) => (
    <MotiView
      from={{ opacity: 0, translateY: 14, scale: 0.98 }}
      animate={{ opacity: 1, translateY: 0, scale: 1 }}
      transition={{
        type: "timing",
        delay: Math.min(index, 12) * 55,
        duration: 280,
      }}
      className="mb-3"
    >
      <Pressable
        onPress={() => router.push(`/thread/${item.id}`)}
        className="rounded-2xl border border-border/50 bg-card px-4 py-4"
      >
        <Text className="text-base text-card-foreground" numberOfLines={2} ellipsizeMode="tail">
          {item.name || item.title || item.id}
        </Text>
        <View className="mt-1 flex-row items-center justify-between gap-3">
          <Text className="flex-1 text-xs text-muted-foreground" numberOfLines={1} ellipsizeMode="middle">
            {item.cwd ?? "No directory"}
          </Text>
          <Text className="text-xs text-muted-foreground">{formatRelativeTime(item.updatedAt)}</Text>
        </View>
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
            onPress={openWorkspacePicker}
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

      <Modal transparent visible={showWorkspacePicker} animationType="fade" onRequestClose={onCancelPicker}>
        <Pressable className="flex-1 items-center justify-center bg-background/80 px-4" onPress={onCancelPicker}>
          <Pressable
            className="w-full rounded-2xl border border-border/50 bg-card p-4"
            onPress={(event) => {
              event.stopPropagation();
            }}
          >
            <Text className="text-lg font-semibold text-card-foreground">Select working directory</Text>
            <Text className="mt-1 text-xs text-muted-foreground">Navigate folders, then select the current folder.</Text>
            <Text className="mt-2 text-xs text-foreground">{breadcrumb}</Text>

            {pickerError ? (
              <View className="mt-2 rounded-xl border border-border/50 bg-destructive/15 px-3 py-2">
                <Text className="text-xs text-destructive-foreground">{pickerError}</Text>
              </View>
            ) : null}

            <View className="mt-3 max-h-64 rounded-xl border border-border/50 bg-muted p-1">
              {loadingDirectories ? (
                <View className="items-center py-4">
                  <ActivityIndicator size="small" color="#22c55e" />
                </View>
              ) : (
                <FlatList
                  data={folders}
                  keyExtractor={(item) => item.path}
                  keyboardShouldPersistTaps="handled"
                  renderItem={({ item }) => (
                    <Pressable
                      className="rounded-lg bg-card mb-1 px-3 py-2"
                      onPress={() => {
                        loadDirectory(item.path).catch(() => undefined);
                      }}
                    >
                      <Text className="text-foreground">{item.name}</Text>
                    </Pressable>
                  )}
                  ListEmptyComponent={
                    <View className="py-4">
                      <Text className="text-center text-xs text-muted-foreground">No folders here.</Text>
                    </View>
                  }
                />
              )}
            </View>

            <View className="mt-4 flex-row gap-2">
              <Pressable
                className="flex-1 rounded-xl border border-border/50 bg-muted px-3 py-3"
                onPress={() => {
                  if (parentDirectory) {
                    loadDirectory(parentDirectory).catch(() => undefined);
                  }
                }}
                disabled={!parentDirectory || loadingDirectories}
              >
                <Text className="text-center text-sm font-semibold text-foreground">Up</Text>
              </Pressable>
              <Pressable
                className="flex-1 rounded-xl border border-border/50 bg-muted px-3 py-3"
                onPress={onCancelPicker}
              >
                <Text className="text-center text-sm font-semibold text-foreground">Cancel</Text>
              </Pressable>
              <Pressable
                className="flex-1 rounded-xl border border-border/50 bg-primary px-3 py-3"
                onPress={() => {
                  if (currentDirectory) {
                    onCreateThread(currentDirectory).catch(() => undefined);
                  }
                }}
                disabled={creating || !currentDirectory}
              >
                <Text className="text-center text-sm font-semibold text-primary-foreground">{creating ? "Creating..." : "Select"}</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}
