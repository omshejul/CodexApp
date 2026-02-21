import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Modal, Pressable, RefreshControl, Text, View } from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { MotiView } from "moti";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  clearSession,
  createThread,
  getCurrentServerBaseUrl,
  getDirectories,
  getGatewayOptions,
  getThreads,
  ReauthRequiredError,
} from "@/lib/api";

interface ThreadItem {
  id: string;
  name?: string;
  title?: string;
  updatedAt?: string;
  cwd?: string;
}

function formatPathForDisplay(fullPath: string | null): string {
  if (!fullPath) {
    return "Loading...";
  }

  const homeMatch = fullPath.match(/^\/Users\/[^/]+(?:\/|$)/);
  if (homeMatch) {
    const home = homeMatch[0].endsWith("/") ? homeMatch[0].slice(0, -1) : homeMatch[0];
    if (fullPath === home) {
      return "~/";
    }
    if (fullPath.startsWith(`${home}/`)) {
      return `~/${fullPath.slice(home.length + 1)}`;
    }
  }

  return fullPath;
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
  const [showSettingsMenu, setShowSettingsMenu] = useState(false);
  const [settingsInfoLoading, setSettingsInfoLoading] = useState(false);
  const [settingsInfoError, setSettingsInfoError] = useState<string | null>(null);
  const [pairedServer, setPairedServer] = useState<string | null>(null);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [modelCount, setModelCount] = useState<number | null>(null);
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

  const openSettingsMenu = async () => {
    setShowSettingsMenu(true);
    setSettingsInfoLoading(true);
    setSettingsInfoError(null);
    try {
      const [serverBaseUrl, options] = await Promise.all([getCurrentServerBaseUrl(), getGatewayOptions()]);
      setPairedServer(serverBaseUrl);
      setDefaultModel(options.defaultModel ?? null);
      setModelCount(options.models.length);
    } catch (settingsError) {
      if (settingsError instanceof ReauthRequiredError) {
        await clearSession();
        router.replace("/pair");
        return;
      }
      setSettingsInfoError(settingsError instanceof Error ? settingsError.message : "Unable to load settings info");
    } finally {
      setSettingsInfoLoading(false);
    }
  };

  const breadcrumb = formatPathForDisplay(currentDirectory);

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
      <MotiView
        from={{ opacity: 0, translateY: -10 }}
        animate={{ opacity: 1, translateY: 0 }}
        transition={{ type: "timing", duration: 280 }}
      >
        <View className="mb-4 flex-row items-center justify-between">
          <Text className="text-3xl font-semibold text-foreground">Threads</Text>
          <View className="flex-row gap-2">
            <Pressable
              className="h-10 w-10 items-center justify-center rounded-full border border-border/50 bg-primary"
              onPress={openWorkspacePicker}
              disabled={creating}
              accessibilityRole="button"
              accessibilityLabel={creating ? "Creating new chat" : "New chat"}
            >
              {creating ? (
                <ActivityIndicator size="small" color="#ffffff" />
              ) : (
                <Ionicons name="add" size={22} color="#ffffff" />
              )}
            </Pressable>
            <Pressable
              className="h-10 w-10 items-center justify-center rounded-full border border-border/50 bg-muted"
              onPress={() => {
                openSettingsMenu().catch(() => undefined);
              }}
              accessibilityRole="button"
              accessibilityLabel="Settings"
            >
              <Ionicons name="settings-outline" size={18} color="#e5e7eb" />
            </Pressable>
          </View>
        </View>
      </MotiView>

      {error ? (
        <MotiView
          from={{ opacity: 0, translateY: -8 }}
          animate={{ opacity: 1, translateY: 0 }}
          transition={{ type: "timing", duration: 220 }}
        >
          <View className="mb-4 rounded-xl border border-border/50 bg-destructive/15 p-3">
            <Text className="text-sm text-destructive-foreground">{error}</Text>
          </View>
        </MotiView>
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
        <MotiView
          className="flex-1"
          from={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ type: "timing", duration: 220 }}
        >
          <Pressable className="flex-1 items-center justify-center bg-background/80 px-4" onPress={onCancelPicker}>
            <MotiView
              className="w-full"
              from={{ opacity: 0, scale: 0.96, translateY: 14 }}
              animate={{ opacity: 1, scale: 1, translateY: 0 }}
              transition={{ type: "timing", duration: 260 }}
            >
              <Pressable
                className="w-full rounded-2xl border border-border/50 bg-card p-4"
                onPress={(event) => {
                  event.stopPropagation();
                }}
              >
            <View className="flex-row items-center gap-2">
              <Ionicons name="folder-open-outline" size={18} color="#e5e7eb" />
              <Text className="text-lg font-semibold text-card-foreground">Choose folder</Text>
            </View>
            <Text className="mt-1 text-xs text-muted-foreground">Navigate folders, then open the current folder.</Text>

            <View className="mt-3 flex-row items-center justify-between rounded-xl border border-border/50 bg-muted px-3 py-2">
              <View className="flex-row items-center gap-2">
                <Ionicons name="home-outline" size={14} color="#9ca3af" />
                <Text className="text-xs text-foreground" numberOfLines={1} ellipsizeMode="middle">
                  {breadcrumb}
                </Text>
              </View>
              <Pressable
                className="flex-row items-center gap-1 rounded-lg border border-border/50 bg-card px-2 py-1"
                onPress={() => {
                  if (parentDirectory) {
                    loadDirectory(parentDirectory).catch(() => undefined);
                  }
                }}
                disabled={!parentDirectory || loadingDirectories}
              >
                <Ionicons name="arrow-up-outline" size={14} color={parentDirectory ? "#e5e7eb" : "#6b7280"} />
                <Text className={`text-xs font-semibold ${parentDirectory ? "text-foreground" : "text-muted-foreground"}`}>Up</Text>
              </Pressable>
            </View>

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
                      <View className="flex-row items-center justify-between">
                        <View className="flex-row items-center gap-2">
                          <Ionicons name="folder-outline" size={14} color="#d1d5db" />
                          <Text className="text-foreground">{item.name}</Text>
                        </View>
                        <Ionicons name="chevron-forward" size={14} color="#6b7280" />
                      </View>
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
                    <Text className="text-center text-sm font-semibold text-primary-foreground">{creating ? "Creating..." : "Open Directory"}</Text>
                  </Pressable>
                </View>
              </Pressable>
            </MotiView>
          </Pressable>
        </MotiView>
      </Modal>

      <Modal
        transparent
        visible={showSettingsMenu}
        animationType="fade"
        onRequestClose={() => {
          setShowSettingsMenu(false);
        }}
      >
        <MotiView
          className="flex-1"
          from={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ type: "timing", duration: 220 }}
        >
          <Pressable
            className="flex-1 items-center justify-center bg-background/80 px-4"
            onPress={() => {
              setShowSettingsMenu(false);
            }}
          >
            <MotiView
              className="w-full"
              from={{ opacity: 0, scale: 0.96, translateY: 14 }}
              animate={{ opacity: 1, scale: 1, translateY: 0 }}
              transition={{ type: "timing", duration: 260 }}
            >
              <Pressable
                className="w-full rounded-2xl border border-border/50 bg-card p-4"
                onPress={(event) => {
                  event.stopPropagation();
                }}
              >
            <Text className="text-lg font-semibold text-card-foreground">Settings</Text>
            <Text className="mt-1 text-xs text-muted-foreground">User info and pairing.</Text>

            <View className="mt-4 px-1">
              <Text className="text-xs text-muted-foreground">Paired server</Text>
              <Text className="mt-1 text-sm text-foreground" numberOfLines={1} ellipsizeMode="middle">
                {pairedServer ?? "Unknown"}
              </Text>
            </View>

            <View className="mt-3 px-1">
              <Text className="text-xs text-muted-foreground">Default model</Text>
              <Text className="mt-1 text-sm text-foreground">{defaultModel ?? "Unknown"}</Text>
            </View>

            <View className="mt-3 px-1">
              <Text className="text-xs text-muted-foreground">Available models</Text>
              <Text className="mt-1 text-sm text-foreground">{modelCount ?? 0}</Text>
            </View>

            {settingsInfoLoading ? (
              <View className="mt-3 px-1">
                <Text className="text-xs text-muted-foreground">Loading user info...</Text>
              </View>
            ) : null}

            {settingsInfoError ? (
              <View className="mt-3 px-1">
                <Text className="text-xs text-destructive-foreground">{settingsInfoError}</Text>
              </View>
            ) : null}

                <Pressable
                  className="mt-3 rounded-xl border border-border/50 bg-muted px-3 py-3"
                  onPress={async () => {
                    setShowSettingsMenu(false);
                    await clearSession();
                    router.replace("/pair");
                  }}
                >
                  <View className="flex-row items-center justify-center gap-2">
                    <Ionicons name="link-outline" size={16} color="#e5e7eb" />
                    <Text className="text-sm font-semibold text-foreground">Re-Pair Device</Text>
                  </View>
                </Pressable>
              </Pressable>
            </MotiView>
          </Pressable>
        </MotiView>
      </Modal>
    </SafeAreaView>
  );
}
