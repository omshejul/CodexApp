import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Linking, Modal, Pressable, RefreshControl, ScrollView, Text, useWindowDimensions, View } from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { MotiView } from "moti";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  ApiHttpError,
  clearSession,
  createThread,
  getCurrentServerBaseUrl,
  getDirectories,
  getGatewayOptions,
  getPairedDevices,
  getThreads,
  ReauthRequiredError,
} from "@/lib/api";
import { getOrCreateDeviceIdentity } from "@/lib/device";

interface ThreadItem {
  id: string;
  name?: string;
  title?: string;
  updatedAt?: string;
  cwd?: string;
}

type LoadingStep = "session" | "gateway" | "threads" | "render";

const loadingStepOrder: LoadingStep[] = ["session", "gateway", "threads", "render"];

const loadingStepLabels: Record<LoadingStep, { title: string; detail: string }> = {
  session: {
    title: "Checking pairing session",
    detail: "Reading secure token and server info from this device.",
  },
  gateway: {
    title: "Connecting to gateway",
    detail: "Opening a secure connection to your paired laptop.",
  },
  threads: {
    title: "Fetching threads",
    detail: "Requesting your latest thread list from the gateway.",
  },
  render: {
    title: "Preparing UI",
    detail: "Sorting and rendering your conversations.",
  },
};

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
  const { height: windowHeight } = useWindowDimensions();
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
  const [pairedDevices, setPairedDevices] = useState<Array<{
    id: string;
    deviceId: string;
    deviceName: string;
    createdAt: number;
    expiresAt: number;
  }>>([]);
  const [loadingDirectories, setLoadingDirectories] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [currentDirectory, setCurrentDirectory] = useState<string | null>(null);
  const [parentDirectory, setParentDirectory] = useState<string | null>(null);
  const [folders, setFolders] = useState<Array<{ name: string; path: string }>>([]);
  const [currentDeviceId, setCurrentDeviceId] = useState<string | null>(null);
  const [loadingStep, setLoadingStep] = useState<LoadingStep>("session");
  const [loadingSeconds, setLoadingSeconds] = useState(0);

  useEffect(() => {
    if (!loading) {
      setLoadingSeconds(0);
      return;
    }

    const startedAt = Date.now();
    const timer = setInterval(() => {
      setLoadingSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 250);

    return () => {
      clearInterval(timer);
    };
  }, [loading]);

  const loadThreads = useCallback(async () => {
    setError(null);
    setLoadingStep("session");
    try {
      setLoadingStep("gateway");
      const response = await getThreads();
      setLoadingStep("threads");
      setThreads(response.threads);
      setLoadingStep("render");
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
    setDefaultModel(null);
    setModelCount(0);
    setPairedDevices([]);
    try {
      const identity = await getOrCreateDeviceIdentity();
      setCurrentDeviceId(identity.deviceId);
      const serverBaseUrl = await getCurrentServerBaseUrl();
      setPairedServer(serverBaseUrl);
      const [optionsResult, devicesResult] = await Promise.allSettled([getGatewayOptions(), getPairedDevices()]);

      if (optionsResult.status === "fulfilled") {
        setDefaultModel(optionsResult.value.defaultModel ?? null);
        setModelCount(optionsResult.value.models.length);
      } else if (!(optionsResult.reason instanceof ApiHttpError && optionsResult.reason.status === 404)) {
        throw optionsResult.reason;
      }

      if (devicesResult.status === "fulfilled") {
        setPairedDevices(devicesResult.value.devices);
      } else if (!(devicesResult.reason instanceof ApiHttpError && devicesResult.reason.status === 404)) {
        throw devicesResult.reason;
      }
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

  const openHelpEmail = async () => {
    const helpUrl = "mailto:contact@omshejul.com";
    const canOpen = await Linking.canOpenURL(helpUrl);
    if (canOpen) {
      await Linking.openURL(helpUrl);
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

  const showInitialLoading = loading && !refreshing && threads.length === 0 && !error;
  const activeStepIndex = loadingStepOrder.indexOf(loadingStep);
  const isSlowLoad = loadingSeconds >= 8;
  const settingsPanelMaxHeight = Math.floor(windowHeight * 0.8);

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
                <ActivityIndicator size="small" className="text-primary-foreground" />
              ) : (
                <Ionicons name="add" size={22} className="text-primary-foreground" />
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
              <Ionicons name="settings-outline" size={18} className="text-foreground" />
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

      {showInitialLoading ? (
        <MotiView
          from={{ opacity: 0, translateY: 10 }}
          animate={{ opacity: 1, translateY: 0 }}
          transition={{ type: "timing", duration: 260 }}
        >
          <View className="rounded-2xl border border-border/50 bg-card p-4">
            <View className="mb-2 flex-row items-center gap-2">
              <ActivityIndicator size="small" className="text-primary" />
              <Text className="text-sm font-semibold text-card-foreground">Loading your threads</Text>
            </View>
            <Text className="mb-3 text-xs text-muted-foreground">Elapsed: {loadingSeconds}s</Text>
            <View className="gap-3">
              {loadingStepOrder.map((step, index) => {
                const isDone = index < activeStepIndex;
                const isActive = index === activeStepIndex;
                const iconName = isDone ? "checkmark-circle" : isActive ? "sync-circle" : "ellipse-outline";
                const iconClass = isDone ? "text-success" : isActive ? "text-primary" : "text-muted-foreground";
                return (
                  <View key={step} className="flex-row items-start gap-2">
                    <Ionicons name={iconName as "checkmark-circle" | "sync-circle" | "ellipse-outline"} size={16} className={iconClass} />
                    <View className="flex-1">
                      <Text className={`text-sm ${isActive || isDone ? "text-card-foreground" : "text-muted-foreground"}`}>
                        {loadingStepLabels[step].title}
                      </Text>
                      <Text className="text-xs text-muted-foreground">{loadingStepLabels[step].detail}</Text>
                    </View>
                  </View>
                );
              })}
            </View>
            {isSlowLoad ? (
              <View className="mt-3 rounded-xl border border-border/50 bg-muted p-3">
                <Text className="text-xs text-muted-foreground">
                  Still working. This usually means the gateway is waking up or network is slow.
                </Text>
              </View>
            ) : null}
          </View>
        </MotiView>
      ) : (
        <FlatList
          data={threads}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={{ paddingBottom: 24 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} className="text-primary" />}
          ListFooterComponent={
            loading || refreshing ? (
              <View className="items-center py-4">
                <ActivityIndicator size="small" className="text-primary" />
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
      )}

      <Modal transparent visible={showWorkspacePicker} animationType="fade" onRequestClose={onCancelPicker}>
        <MotiView
          className="flex-1"
          from={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ type: "timing", duration: 220 }}
        >
          <Pressable className="flex-1 items-center justify-center bg-background/80 px-5" onPress={onCancelPicker}>
            <MotiView
              className="w-full"
              from={{ opacity: 0, scale: 0.96, translateY: 14 }}
              animate={{ opacity: 1, scale: 1, translateY: 0 }}
              transition={{ type: "timing", duration: 260 }}
            >
              <Pressable
                className="w-full rounded-2xl border border-border/50 bg-card p-5"
                onPress={(event) => {
                  event.stopPropagation();
                }}
              >
                <View className="flex-row items-center gap-3">
                  <View className="h-9 w-9 items-center justify-center rounded-xl bg-primary/15">
                    <Ionicons name="folder-open-outline" size={18} className="text-primary" />
                  </View>
                  <View className="flex-1">
                    <Text className="text-lg font-semibold text-card-foreground">Choose folder</Text>
                    <Text className="text-xs text-muted-foreground">Select a working directory for the new thread.</Text>
                  </View>
                  <Pressable
                    className="h-8 w-8 items-center justify-center rounded-full"
                    onPress={onCancelPicker}
                    hitSlop={8}
                  >
                    <Ionicons name="close" size={18} className="text-muted-foreground" />
                  </Pressable>
                </View>

                <View className="my-4 h-px bg-border/50" />

                <View className="flex-row items-center justify-between rounded-xl bg-muted/60 px-3 py-2.5">
                  <View className="mr-2 flex-1 flex-row items-center gap-2">
                    <Ionicons name="location-outline" size={14} className="text-muted-foreground" />
                    <Text className="flex-1 text-xs font-medium text-foreground" numberOfLines={1} ellipsizeMode="middle">
                      {breadcrumb}
                    </Text>
                  </View>
                  <Pressable
                    className={`flex-row items-center gap-1 rounded-lg px-2.5 py-1.5 ${parentDirectory ? "bg-card border border-border/50" : "opacity-40"}`}
                    onPress={() => {
                      if (parentDirectory) {
                        loadDirectory(parentDirectory).catch(() => undefined);
                      }
                    }}
                    disabled={!parentDirectory || loadingDirectories}
                  >
                    <Ionicons name="arrow-up-outline" size={13} className={parentDirectory ? "text-foreground" : "text-muted-foreground"} />
                    <Text className={`text-xs font-medium ${parentDirectory ? "text-foreground" : "text-muted-foreground"}`}>Up</Text>
                  </Pressable>
                </View>

                {pickerError ? (
                  <View className="mt-2.5 flex-row items-center gap-2 rounded-xl bg-destructive/10 px-3 py-2.5">
                    <Ionicons name="alert-circle-outline" size={14} className="text-destructive" />
                    <Text className="flex-1 text-xs text-destructive-foreground">{pickerError}</Text>
                  </View>
                ) : null}

                <View className="mt-3 max-h-72 rounded-xl border border-border/30 bg-muted/40 p-1.5">
                  {loadingDirectories ? (
                    <View className="items-center py-6">
                      <ActivityIndicator size="small" className="text-primary" />
                      <Text className="mt-2 text-xs text-muted-foreground">Loading folders...</Text>
                    </View>
                  ) : (
                    <FlatList
                      data={folders}
                      keyExtractor={(item) => item.path}
                      keyboardShouldPersistTaps="handled"
                      renderItem={({ item }) => (
                        <Pressable
                          className="mb-0.5 flex-row items-center justify-between rounded-lg bg-card/80 px-3 py-2.5 active:bg-card"
                          onPress={() => {
                            loadDirectory(item.path).catch(() => undefined);
                          }}
                        >
                          <View className="flex-1 flex-row items-center gap-2.5">
                            <Ionicons name="folder" size={15} className="text-primary" />
                            <Text className="text-sm text-foreground">{item.name}</Text>
                          </View>
                          <Ionicons name="chevron-forward" size={13} className="text-muted-foreground" />
                        </Pressable>
                      )}
                      ListEmptyComponent={
                        <View className="items-center py-6">
                          <Ionicons name="folder-open-outline" size={24} className="text-muted-foreground" />
                          <Text className="mt-1.5 text-xs text-muted-foreground">No subfolders</Text>
                        </View>
                      }
                    />
                  )}
                </View>

                <View className="mt-4 flex-row gap-2.5">
                  <Pressable
                    className="flex-1 rounded-xl border border-border/50 bg-muted py-3"
                    onPress={onCancelPicker}
                  >
                    <Text className="text-center text-sm font-semibold text-muted-foreground">Cancel</Text>
                  </Pressable>
                  <Pressable
                    className={`flex-1 flex-row items-center justify-center gap-2 rounded-xl py-3 ${creating || !currentDirectory ? "bg-primary/50" : "bg-primary"}`}
                    onPress={() => {
                      if (currentDirectory) {
                        onCreateThread(currentDirectory).catch(() => undefined);
                      }
                    }}
                    disabled={creating || !currentDirectory}
                  >
                    {creating ? (
                      <ActivityIndicator size="small" className="text-primary-foreground" />
                    ) : (
                      <Ionicons name="open-outline" size={15} className="text-primary-foreground" />
                    )}
                    <Text className="text-center text-sm font-semibold text-primary-foreground">
                      {creating ? "Creating..." : "Open Here"}
                    </Text>
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
          <View className="flex-1 items-center justify-center px-4">
            <Pressable
              className="absolute inset-0 bg-background/80"
              onPress={() => {
                setShowSettingsMenu(false);
              }}
            />
            <MotiView
              className="w-full"
              from={{ opacity: 0, scale: 0.96, translateY: 14 }}
              animate={{ opacity: 1, scale: 1, translateY: 0 }}
              transition={{ type: "timing", duration: 260 }}
            >
              <View className="w-full rounded-2xl border border-border/50 bg-card" style={{ maxHeight: settingsPanelMaxHeight }}>
                <ScrollView
                  className="p-4"
                  contentContainerStyle={{ paddingBottom: 8 }}
                  showsVerticalScrollIndicator
                  nestedScrollEnabled
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

            <View className="mt-4 px-1">
              <Text className="text-xs text-muted-foreground">Paired devices</Text>
              {pairedDevices.length === 0 ? (
                <Text className="mt-1 text-sm text-foreground">No active devices</Text>
              ) : (
                <View className="mt-1 gap-2">
                  {pairedDevices.slice(0, 4).map((device) => (
                    <View key={device.id} className="rounded-xl bg-muted/50 px-3 py-2.5">
                      <View className="flex-row items-center justify-between">
                        <View className="flex-1 flex-row items-center gap-2">
                          <Text className="text-sm font-semibold text-foreground">{device.deviceName}</Text>
                          {currentDeviceId === device.deviceId ? (
                            <View className="rounded-full bg-primary/15 px-1.5 py-0.5">
                              <Text className="text-[9px] font-bold tracking-wider text-primary">YOU</Text>
                            </View>
                          ) : null}
                        </View>
                      </View>
                      <Text className="mt-1 text-[11px] text-muted-foreground" numberOfLines={1} ellipsizeMode="middle">
                        {device.deviceId}
                      </Text>
                      <View className="mt-2 flex-row items-center gap-4">
                        <View className="gap-0.5">
                          <Text className="text-[10px] uppercase tracking-wider text-muted-foreground/60">Added</Text>
                          <Text className="text-[11px] font-medium text-muted-foreground">
                            {new Date(device.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                          </Text>
                        </View>
                        <View className="gap-0.5">
                          <Text className="text-[10px] uppercase tracking-wider text-muted-foreground/60">Expires</Text>
                          <Text className="text-[11px] font-medium text-muted-foreground">
                            {device.expiresAt >= 253402300799000 ? "Never" : new Date(device.expiresAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                          </Text>
                        </View>
                      </View>
                    </View>
                  ))}
                </View>
              )}
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
                      <Ionicons name="link-outline" size={16} className="text-foreground" />
                      <Text className="text-sm font-semibold text-foreground">Re-Pair Device</Text>
                    </View>
                  </Pressable>

                  <Pressable
                    className="mt-3 rounded-xl border border-border/50 bg-muted px-3 py-3"
                    onPress={() => {
                      openHelpEmail().catch(() => undefined);
                    }}
                  >
                    <View className="flex-row items-center justify-center gap-2">
                      <Ionicons name="help-circle-outline" size={16} className="text-foreground" />
                      <Text className="text-sm font-semibold text-foreground">Help</Text>
                    </View>
                  </Pressable>
                </ScrollView>
              </View>
            </MotiView>
          </View>
        </MotiView>
      </Modal>
    </SafeAreaView>
  );
}
