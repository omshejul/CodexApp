import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  SectionList,
  Text,
  TextInput,
  useWindowDimensions,
  View
} from "react-native";
import { router, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import Constants from "expo-constants";
import { MotiView } from "moti";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import {
  ApiHttpError,
  createDirectory,
  createThread,
  GatewaySummary,
  getActiveGatewayId,
  getGatewayById,
  getCurrentServerBaseUrl,
  getDirectories,
  getGatewayOptions,
  getPairedDevices,
  getThreads,
  hasStoredPairing,
  listGateways,
  logoutGateway,
  removeGateway,
  ReauthRequiredError,
  renameGateway,
  setActiveGateway,
} from "@/lib/api";
import { getOrCreateDeviceIdentity } from "@/lib/device";
import { formatPathForDisplay } from "@/lib/path";

interface ThreadItem {
  id: string;
  name?: string;
  title?: string;
  updatedAt?: string;
  cwd?: string;
  inProgress?: boolean;
}

interface ThreadSection {
  title: string;
  data: ThreadItem[];
}

function getUpdatedAtTimestamp(updatedAt?: string): number {
  if (!updatedAt) {
    return 0;
  }

  const timestamp = new Date(updatedAt).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function groupThreadsByDirectory(threads: ThreadItem[]): ThreadSection[] {
  const sortedByTime = [...threads].sort((left, right) => {
    const timeDiff = getUpdatedAtTimestamp(right.updatedAt) - getUpdatedAtTimestamp(left.updatedAt);
    if (timeDiff !== 0) {
      return timeDiff;
    }

    return left.id.localeCompare(right.id);
  });

  const sections = new Map<string, ThreadItem[]>();
  for (const thread of sortedByTime) {
    const directory = thread.cwd?.trim() ?? "";
    const section = sections.get(directory);
    if (section) {
      section.push(thread);
      continue;
    }

    sections.set(directory, [thread]);
  }

  return Array.from(sections.entries()).map(([directory, data]) => ({
    title: directory ? formatPathForDisplay(directory) : "No directory",
    data,
  }));
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
const MAX_GATEWAY_NICKNAME_LENGTH = 40;

function formatRelativeTime(updatedAt?: string): string {
  if (!updatedAt) {
    return "Unknown update time";
  }

  const timestamp = new Date(updatedAt).getTime();
  if (!Number.isFinite(timestamp)) {
    return "Unknown update time";
  }

  const absSeconds = Math.abs(Math.round((timestamp - Date.now()) / 1000));

  if (absSeconds < 60) {
    return "now";
  }
  if (absSeconds < 3600) {
    return `${Math.round(absSeconds / 60)}m`;
  }
  if (absSeconds < 86400) {
    return `${Math.round(absSeconds / 3600)}h`;
  }
  if (absSeconds < 604800) {
    return `${Math.round(absSeconds / 86400)}d`;
  }
  if (absSeconds < 2629800) {
    return `${Math.round(absSeconds / 604800)}w`;
  }
  if (absSeconds < 31557600) {
    return `${Math.round(absSeconds / 2629800)}mo`;
  }
  return `${Math.round(absSeconds / 31557600)}y`;
}

export default function ThreadsScreen() {
  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const appVersion = Constants.expoConfig?.version ?? "Unknown";
  const [activeGatewayId, setActiveGatewayId] = useState<string | null>(null);
  const [activeGatewayName, setActiveGatewayName] = useState<string | null>(null);
  const [gateways, setGateways] = useState<GatewaySummary[]>([]);
  const [showGatewayMenu, setShowGatewayMenu] = useState(false);
  const [gatewayMenuError, setGatewayMenuError] = useState<string | null>(null);
  const [gatewayActionLoadingId, setGatewayActionLoadingId] = useState<string | null>(null);
  const [renamingGatewayId, setRenamingGatewayId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameSaving, setRenameSaving] = useState(false);
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
  const [showCreateFolderInput, setShowCreateFolderInput] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [currentDeviceId, setCurrentDeviceId] = useState<string | null>(null);
  const [loadingStep, setLoadingStep] = useState<LoadingStep>("session");
  const [loadingSeconds, setLoadingSeconds] = useState(0);
  const hasLoadedThreadsOnceRef = useRef(false);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  const allSections = useMemo(() => groupThreadsByDirectory(threads), [threads]);
  const sections = useMemo(
    () =>
      allSections.map((section) => ({
        ...section,
        data: collapsedSections.has(section.title) ? [] : section.data,
      })),
    [allSections, collapsedSections],
  );

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

  const refreshGatewayState = useCallback(async (): Promise<string | null> => {
    const allGateways = await listGateways();
    setGateways(allGateways);
    const activeGateway = allGateways.find((gateway) => gateway.isActive) ?? null;
    const nextActiveGatewayId = activeGateway?.id ?? null;
    setActiveGatewayId(nextActiveGatewayId);
    setActiveGatewayName(activeGateway?.nickname ?? null);
    setPairedServer(activeGateway?.serverBaseUrl ?? null);
    return nextActiveGatewayId;
  }, []);

  const recoverFromReauth = useCallback(async (): Promise<string | null> => {
    const stillPaired = await hasStoredPairing();
    if (!stillPaired) {
      router.replace("/pair");
      return null;
    }
    return refreshGatewayState();
  }, [refreshGatewayState]);

  const loadThreads = useCallback(
    async (showInitialLoader = false, explicitGatewayId?: string | null) => {
      setError(null);
      if (showInitialLoader) {
        setLoading(true);
      }
      setLoadingStep("session");

      const resolveGatewayId = async () => {
        if (explicitGatewayId) {
          return explicitGatewayId;
        }
        if (activeGatewayId) {
          return activeGatewayId;
        }
        const storedActiveGatewayId = await getActiveGatewayId();
        if (storedActiveGatewayId) {
          setActiveGatewayId(storedActiveGatewayId);
          return storedActiveGatewayId;
        }
        return refreshGatewayState();
      };

      try {
        let targetGatewayId = await resolveGatewayId();
        if (!targetGatewayId) {
          router.replace("/pair");
          return;
        }

        setLoadingStep("gateway");
        let response;
        try {
          response = await getThreads(targetGatewayId);
        } catch (loadError) {
          if (!(loadError instanceof ReauthRequiredError)) {
            throw loadError;
          }
          targetGatewayId = await recoverFromReauth();
          if (!targetGatewayId) {
            return;
          }
          response = await getThreads(targetGatewayId);
        }

        setLoadingStep("threads");
        setThreads(response.threads);
        setLoadingStep("render");
        setActiveGatewayId(targetGatewayId);
        const gateway = await getGatewayById(targetGatewayId);
        setActiveGatewayName(gateway?.nickname ?? gateway?.host ?? null);
        setPairedServer(gateway?.serverBaseUrl ?? null);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "Unable to load threads");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [activeGatewayId, recoverFromReauth, refreshGatewayState]
  );

  useFocusEffect(
    useCallback(() => {
      let mounted = true;
      const showInitialLoader = !hasLoadedThreadsOnceRef.current;
      (async () => {
        const gatewayId = await refreshGatewayState();
        if (!mounted) {
          return;
        }
        await loadThreads(showInitialLoader, gatewayId);
        hasLoadedThreadsOnceRef.current = true;
      })().catch((focusError) => {
        if (!mounted) {
          return;
        }
        setError(focusError instanceof Error ? focusError.message : "Unable to load threads");
      });
      return () => {
        mounted = false;
      };
    }, [loadThreads, refreshGatewayState])
  );

  const onRefresh = () => {
    setRefreshing(true);
    loadThreads(false, activeGatewayId).catch(() => {
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
      const gatewayId = activeGatewayId ?? (await refreshGatewayState());
      if (!gatewayId) {
        router.replace("/pair");
        return;
      }
      const created = await createThread({ cwd }, gatewayId);
      router.push(`/thread/${created.threadId}?gatewayId=${encodeURIComponent(gatewayId)}`);
      setShowWorkspacePicker(false);
    } catch (createError) {
      if (createError instanceof ReauthRequiredError) {
        const fallbackGatewayId = await recoverFromReauth();
        if (!fallbackGatewayId) {
          return;
        }
        setError("Gateway session expired. Switched to another paired gateway.");
        await loadThreads(false, fallbackGatewayId);
        return;
      }
      setError(createError instanceof Error ? createError.message : "Unable to create thread");
    } finally {
      setCreating(false);
    }
  };

  const loadDirectory = async (pathValue?: string, explicitGatewayId?: string | null) => {
    if (loadingDirectories) {
      return;
    }

    const gatewayId = explicitGatewayId ?? activeGatewayId ?? (await getActiveGatewayId());
    if (!gatewayId) {
      router.replace("/pair");
      return;
    }

    setLoadingDirectories(true);
    try {
      const response = await getDirectories(pathValue, gatewayId);
      setCurrentDirectory(response.currentPath);
      setParentDirectory(response.parentPath);
      setFolders(response.folders);
      setPickerError(null);
    } catch (directoryError) {
      if (directoryError instanceof ReauthRequiredError) {
        const fallbackGatewayId = await recoverFromReauth();
        if (!fallbackGatewayId) {
          return;
        }
        await loadDirectory(pathValue, fallbackGatewayId);
        return;
      }
      setPickerError(directoryError instanceof Error ? directoryError.message : "Unable to load folders");
    } finally {
      setLoadingDirectories(false);
    }
  };

  const onCreateFolder = async () => {
    if (creatingFolder) {
      return;
    }

    const parentPath = currentDirectory?.trim();
    if (!parentPath) {
      setPickerError("No directory selected.");
      return;
    }

    const folderName = newFolderName.trim();
    if (folderName.length === 0) {
      setPickerError("Enter a folder name.");
      return;
    }

    const createAndReload = async (gatewayId: string) => {
      const response = await createDirectory(
        {
          parentPath,
          name: folderName,
        },
        gatewayId
      );
      setNewFolderName("");
      setShowCreateFolderInput(false);
      await loadDirectory(response.createdPath, gatewayId);
    };

    setCreatingFolder(true);
    setPickerError(null);
    try {
      const gatewayId = activeGatewayId ?? (await refreshGatewayState());
      if (!gatewayId) {
        router.replace("/pair");
        return;
      }
      await createAndReload(gatewayId);
    } catch (createFolderError) {
      if (createFolderError instanceof ReauthRequiredError) {
        const fallbackGatewayId = await recoverFromReauth();
        if (!fallbackGatewayId) {
          return;
        }
        try {
          await createAndReload(fallbackGatewayId);
        } catch (retryError) {
          setPickerError(retryError instanceof Error ? retryError.message : "Unable to create folder");
        }
        return;
      }
      setPickerError(createFolderError instanceof Error ? createFolderError.message : "Unable to create folder");
    } finally {
      setCreatingFolder(false);
    }
  };

  const openWorkspacePicker = async () => {
    if (creating) {
      return;
    }

    setShowWorkspacePicker(true);
    setPickerError(null);
    setShowCreateFolderInput(false);
    setNewFolderName("");
    const lastCwd = allSections[0]?.data[0]?.cwd?.trim() || undefined;
    await loadDirectory(lastCwd);
  };

  const onCancelPicker = () => {
    setShowWorkspacePicker(false);
    setPickerError(null);
    setShowCreateFolderInput(false);
    setNewFolderName("");
  };

  const openSettingsMenu = async (explicitGatewayId?: string | null) => {
    setShowSettingsMenu(true);
    setSettingsInfoLoading(true);
    setSettingsInfoError(null);
    setDefaultModel(null);
    setModelCount(0);
    setPairedDevices([]);
    try {
      const identity = await getOrCreateDeviceIdentity();
      setCurrentDeviceId(identity.deviceId);
      const gatewayId = explicitGatewayId ?? activeGatewayId ?? (await getActiveGatewayId());
      if (!gatewayId) {
        router.replace("/pair");
        return;
      }

      const gateway = await getGatewayById(gatewayId);
      setPairedServer(gateway?.serverBaseUrl ?? (await getCurrentServerBaseUrl()));
      const [optionsResult, devicesResult] = await Promise.allSettled([
        getGatewayOptions(gatewayId),
        getPairedDevices(gatewayId),
      ]);

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
        const fallbackGatewayId = await recoverFromReauth();
        if (!fallbackGatewayId) {
          return;
        }
        await openSettingsMenu(fallbackGatewayId);
        return;
      }
      setSettingsInfoError(settingsError instanceof Error ? settingsError.message : "Unable to load settings info");
    } finally {
      setSettingsInfoLoading(false);
    }
  };

  const openGatewayMenu = async () => {
    setGatewayMenuError(null);
    setShowGatewayMenu(true);
    try {
      await refreshGatewayState();
    } catch (gatewayError) {
      setGatewayMenuError(gatewayError instanceof Error ? gatewayError.message : "Unable to load gateways");
    }
  };

  const finishGatewayRemoval = useCallback(
    async (gatewayId: string) => {
      const result = await removeGateway(gatewayId);
      const nextActiveGatewayId = await refreshGatewayState();
      if (result.remaining === 0 || !nextActiveGatewayId) {
        setShowGatewayMenu(false);
        setShowSettingsMenu(false);
        router.replace("/pair");
        return;
      }
      await loadThreads(true, nextActiveGatewayId);
      if (showSettingsMenu) {
        await openSettingsMenu(nextActiveGatewayId);
      }
    },
    [loadThreads, openSettingsMenu, refreshGatewayState, showSettingsMenu]
  );

  const onSwitchGateway = useCallback(
    async (gatewayId: string) => {
      if (gatewayActionLoadingId || renameSaving) {
        return;
      }
      setGatewayActionLoadingId(gatewayId);
      setGatewayMenuError(null);
      try {
        await setActiveGateway(gatewayId);
        const nextActiveGatewayId = await refreshGatewayState();
        if (!nextActiveGatewayId) {
          router.replace("/pair");
          return;
        }
        await loadThreads(true, nextActiveGatewayId);
        if (showSettingsMenu) {
          await openSettingsMenu(nextActiveGatewayId);
        }
      } catch (gatewayError) {
        setGatewayMenuError(gatewayError instanceof Error ? gatewayError.message : "Unable to switch gateway");
      } finally {
        setGatewayActionLoadingId(null);
      }
    },
    [gatewayActionLoadingId, loadThreads, openSettingsMenu, refreshGatewayState, renameSaving, showSettingsMenu]
  );

  const onSaveGatewayRename = useCallback(
    async (gatewayId: string) => {
      if (renameSaving) {
        return;
      }

      const trimmed = renameDraft.trim().slice(0, MAX_GATEWAY_NICKNAME_LENGTH);
      if (!trimmed) {
        setGatewayMenuError("Nickname is required");
        return;
      }

      setRenameSaving(true);
      setGatewayMenuError(null);
      try {
        await renameGateway(gatewayId, trimmed);
        setRenamingGatewayId(null);
        setRenameDraft("");
        await refreshGatewayState();
      } catch (renameError) {
        setGatewayMenuError(renameError instanceof Error ? renameError.message : "Unable to rename gateway");
      } finally {
        setRenameSaving(false);
      }
    },
    [refreshGatewayState, renameDraft, renameSaving]
  );

  const onRemoveGateway = useCallback(
    async (gateway: GatewaySummary) => {
      if (gatewayActionLoadingId || renameSaving) {
        return;
      }

      setGatewayActionLoadingId(gateway.id);
      setGatewayMenuError(null);
      try {
        await logoutGateway(gateway.id);
        await finishGatewayRemoval(gateway.id);
      } catch (removeError) {
        const message = removeError instanceof Error ? removeError.message : "Unable to reach gateway";
        Alert.alert(
          "Gateway unavailable",
          `${message}\n\nRemove this gateway from your phone anyway?`,
          [
            {
              text: "Cancel",
              style: "cancel",
            },
            {
              text: "Remove locally",
              style: "destructive",
              onPress: () => {
                finishGatewayRemoval(gateway.id).catch(() => undefined);
              },
            },
          ]
        );
      } finally {
        setGatewayActionLoadingId(null);
      }
    },
    [finishGatewayRemoval, gatewayActionLoadingId, renameSaving]
  );

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
      from={{ opacity: 0, translateY: 12 }}
      animate={{ opacity: 1, translateY: 0 }}
      transition={{
        type: "timing",
        delay: Math.min(index, 8) * 50,
        duration: 260,
      }}
    >
      <Pressable
        onPress={() => {
          const gatewayQuery = activeGatewayId ? `?gatewayId=${encodeURIComponent(activeGatewayId)}` : "";
          router.push(`/thread/${item.id}${gatewayQuery}`);
        }}
        className="flex-row items-center gap-3 py-3 pl-6 active:opacity-70"
      >
        <Text className="min-w-0 flex-1 text-[15px] font-medium text-card-foreground" numberOfLines={2} ellipsizeMode="tail">
          {item.name || item.title || item.id}
        </Text>
        <View className="flex-row items-center gap-2">
          {item.inProgress ? <ActivityIndicator size="small" className="text-primary" /> : null}
          <Text className="text-sm text-muted-foreground">{formatRelativeTime(item.updatedAt)}</Text>
        </View>
      </Pressable>
    </MotiView>
  );

  const ItemSeparator = () => <View className="ml-6 h-px bg-border/30" />;

  const toggleSection = (title: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(title)) {
        next.delete(title);
      } else {
        next.add(title);
      }
      return next;
    });
  };

  const renderSectionHeader = ({ section }: { section: ThreadSection }) => {
    const isCollapsed = collapsedSections.has(section.title);

    return (
      <MotiView
        from={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ type: "timing", duration: 200 }}
      >
        <Pressable
          onPress={() => toggleSection(section.title)}
          className="flex-row items-center gap-3 rounded-xl bg-muted/50 px-4 py-4 mt-4 active:opacity-70"
        >
          <Ionicons name="folder-open-outline" size={18} className="text-foreground" />
          <Text className="min-w-0 flex-1 text-base font-bold text-foreground" numberOfLines={1} ellipsizeMode="middle">
            {section.title}
          </Text>
          <Ionicons
            name={isCollapsed ? "chevron-forward" : "chevron-down"}
            size={16}
            className="text-muted-foreground"
          />
        </Pressable>
      </MotiView>
    );
  };

  const showInitialLoading = loading && !refreshing && threads.length === 0 && !error;
  const activeStepIndex = loadingStepOrder.indexOf(loadingStep);
  const isSlowLoad = loadingSeconds >= 8;
  const settingsPanelMaxHeight = Math.floor(windowHeight - insets.top - insets.bottom - 32);
  const devicesListMaxHeight = Math.floor(Math.min(windowHeight * 0.32, 260));

  return (
    <SafeAreaView className="flex-1 bg-background pt-2" edges={["top", "left", "right"]}>
      <MotiView
        from={{ opacity: 0, translateY: -10 }}
        animate={{ opacity: 1, translateY: 0 }}
        transition={{ type: "timing", duration: 280 }}
      >
        <View className="mb-4 px-4">
          <View className="flex-row items-center justify-between">
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

          <Pressable
            className="mt-3 flex-row items-center self-start rounded-xl border border-border/50 bg-muted px-3 py-2 active:opacity-80"
            onPress={() => {
              openGatewayMenu().catch(() => undefined);
            }}
            accessibilityRole="button"
            accessibilityLabel="Switch gateway"
          >
            <Ionicons name="laptop-outline" size={15} className="text-foreground" />
            <Text className="mx-2 text-sm font-semibold text-foreground" numberOfLines={1}>
              {activeGatewayName ?? "Select Gateway"}
            </Text>
            <Ionicons name="chevron-down" size={14} className="text-muted-foreground" />
          </Pressable>
          {pairedServer ? (
            <Text className="mt-1 text-xs text-muted-foreground" numberOfLines={1} ellipsizeMode="middle">
              {pairedServer}
            </Text>
          ) : null}
          {gatewayMenuError ? (
            <Text className="mt-1 text-xs text-destructive-foreground">{gatewayMenuError}</Text>
          ) : null}
        </View>
      </MotiView>

      {error ? (
        <MotiView
          from={{ opacity: 0, translateY: -8 }}
          animate={{ opacity: 1, translateY: 0 }}
          transition={{ type: "timing", duration: 220 }}
        >
          <View className="mx-4 mb-4 rounded-xl border border-border/50 bg-destructive/15 p-3">
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
          <View className="mx-4 rounded-2xl border border-border/50 bg-card p-4">
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
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          renderSectionHeader={renderSectionHeader}
          ItemSeparatorComponent={ItemSeparator}
          stickySectionHeadersEnabled={false}
          showsVerticalScrollIndicator
          contentContainerStyle={{ paddingBottom: 24, paddingHorizontal: 16 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              colors={["#2f7de1"]}
              tintColor="#2f7de1"
              progressBackgroundColor="#171717"
            />
          }
          ListFooterComponent={
            loading || refreshing ? (
              <View className="items-center py-4">
                <ActivityIndicator size="small" className="text-primary" />
              </View>
            ) : null
          }
          ListEmptyComponent={
            !loading ? (
              <MotiView
                from={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ type: "timing", duration: 300 }}
              >
                <View className="mt-8 items-center rounded-2xl border border-dashed border-border/50 bg-card/50 p-8">
                  <View className="mb-3 h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
                    <Ionicons name="chatbubbles-outline" size={28} className="text-primary" />
                  </View>
                  <Text className="text-base font-medium text-card-foreground">No threads yet</Text>
                  <Text className="mt-1 text-center text-sm text-muted-foreground">
                    Tap the + button to start a new conversation.
                  </Text>
                </View>
              </MotiView>
            ) : null
          }
        />
      )}

      <Modal
        transparent
        visible={showGatewayMenu}
        animationType="fade"
        onRequestClose={() => {
          setShowGatewayMenu(false);
          setRenamingGatewayId(null);
          setRenameDraft("");
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
                setShowGatewayMenu(false);
                setRenamingGatewayId(null);
                setRenameDraft("");
              }}
            />
            <MotiView
              className="w-full"
              from={{ opacity: 0, scale: 0.96, translateY: 14 }}
              animate={{ opacity: 1, scale: 1, translateY: 0 }}
              transition={{ type: "timing", duration: 260 }}
            >
              <View className="w-full rounded-2xl border border-border/50 bg-card p-4" style={{ maxHeight: settingsPanelMaxHeight }}>
                <View className="flex-row items-center justify-between">
                  <View>
                    <Text className="text-lg font-semibold text-card-foreground">Gateways</Text>
                    <Text className="mt-1 text-xs text-muted-foreground">Switch, rename, or remove paired Macs.</Text>
                  </View>
                  <Pressable
                    className="rounded-xl border border-border/50 bg-muted px-3 py-2"
                    onPress={() => {
                      setShowGatewayMenu(false);
                      setRenamingGatewayId(null);
                      setRenameDraft("");
                      router.push("/pair");
                    }}
                  >
                    <Text className="text-xs font-semibold text-foreground">Add Gateway</Text>
                  </Pressable>
                </View>

                {gatewayMenuError ? (
                  <View className="mt-3 rounded-xl border border-border/50 bg-destructive/15 p-3">
                    <Text className="text-xs text-destructive-foreground">{gatewayMenuError}</Text>
                  </View>
                ) : null}

                <ScrollView className="mt-3" contentContainerStyle={{ gap: 8, paddingBottom: 2 }} showsVerticalScrollIndicator>
                  {gateways.length === 0 ? (
                    <View className="rounded-xl bg-muted/50 px-3 py-4">
                      <Text className="text-sm text-muted-foreground">No paired gateways yet.</Text>
                    </View>
                  ) : null}

                  {gateways.map((gateway) => {
                    const isLoading = gatewayActionLoadingId === gateway.id;
                    const isRenaming = renamingGatewayId === gateway.id;
                    return (
                      <View key={gateway.id} className="rounded-xl border border-border/40 bg-muted/30 p-3">
                        <View className="flex-row items-center justify-between gap-2">
                          <View className="flex-1">
                            <View className="flex-row items-center gap-2">
                              <Text className="text-sm font-semibold text-foreground">{gateway.nickname}</Text>
                              {gateway.isActive ? (
                                <View className="rounded-full bg-primary/15 px-2 py-0.5">
                                  <Text className="text-[10px] font-semibold text-primary">ACTIVE</Text>
                                </View>
                              ) : null}
                            </View>
                            <Text className="mt-1 text-xs text-muted-foreground" numberOfLines={1} ellipsizeMode="middle">
                              {gateway.serverBaseUrl}
                            </Text>
                          </View>
                          {isLoading ? <ActivityIndicator size="small" className="text-primary" /> : null}
                        </View>

                        {isRenaming ? (
                          <View className="mt-3 rounded-xl border border-border/60 bg-card px-3 py-3">
                            <View className="mb-2 flex-row items-center justify-between">
                              <Text className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                                Rename Gateway
                              </Text>
                              <Text className="text-[11px] text-muted-foreground">
                                {renameDraft.trim().length}/{MAX_GATEWAY_NICKNAME_LENGTH}
                              </Text>
                            </View>
                            <TextInput
                              value={renameDraft}
                              onChangeText={setRenameDraft}
                              maxLength={MAX_GATEWAY_NICKNAME_LENGTH}
                              editable={!renameSaving}
                              autoFocus
                              returnKeyType="done"
                              onSubmitEditing={() => {
                                if (renameSaving || renameDraft.trim().length === 0 || renameDraft.trim() === gateway.nickname.trim()) {
                                  return;
                                }
                                onSaveGatewayRename(gateway.id).catch(() => undefined);
                              }}
                              placeholder={gateway.host}
                              placeholderTextColor="rgba(148, 163, 184, 0.8)"
                              className="rounded-lg border border-border/60 bg-muted px-3 py-2.5 text-sm text-foreground"
                            />
                            <Text className="mt-2 text-[11px] text-muted-foreground" numberOfLines={1} ellipsizeMode="middle">
                              Host: {gateway.host}
                            </Text>
                            <View className="mt-3 flex-row items-center justify-end gap-2">
                              <Pressable
                                className="rounded-lg border border-border/50 bg-muted px-3 py-2"
                                onPress={() => {
                                  setRenamingGatewayId(null);
                                  setRenameDraft("");
                                  setGatewayMenuError(null);
                                }}
                              >
                                <Text className="text-xs font-semibold text-foreground">Cancel</Text>
                              </Pressable>
                              <Pressable
                                className={`rounded-lg px-4 py-2 ${renameSaving || renameDraft.trim().length === 0 || renameDraft.trim() === gateway.nickname.trim() ? "bg-primary/60" : "bg-primary"}`}
                                onPress={() => {
                                  onSaveGatewayRename(gateway.id).catch(() => undefined);
                                }}
                                disabled={renameSaving || renameDraft.trim().length === 0 || renameDraft.trim() === gateway.nickname.trim()}
                              >
                                <Text className="text-xs font-semibold text-primary-foreground">Save</Text>
                              </Pressable>
                            </View>
                          </View>
                        ) : (
                          <View className="mt-3 flex-row gap-2">
                            <Pressable
                              className={`flex-1 rounded-xl border border-border/50 px-2 py-2 ${gateway.isActive ? "bg-muted/60 opacity-60" : "bg-muted"}`}
                              disabled={gateway.isActive || isLoading}
                              onPress={() => {
                                onSwitchGateway(gateway.id).catch(() => undefined);
                              }}
                            >
                              <Text className="text-center text-xs font-semibold text-foreground">
                                {gateway.isActive ? "Current" : "Switch"}
                              </Text>
                            </Pressable>
                            <Pressable
                              className="flex-1 rounded-xl border border-border/50 bg-muted px-2 py-2"
                              disabled={isLoading}
                              onPress={() => {
                                setGatewayMenuError(null);
                                setRenamingGatewayId(gateway.id);
                                setRenameDraft(gateway.nickname);
                              }}
                            >
                              <Text className="text-center text-xs font-semibold text-foreground">Rename</Text>
                            </Pressable>
                            <Pressable
                              className="flex-1 rounded-xl border border-destructive/30 bg-destructive/10 px-2 py-2"
                              disabled={isLoading}
                              onPress={() => {
                                onRemoveGateway(gateway).catch(() => undefined);
                              }}
                            >
                              <Text className="text-center text-xs font-semibold text-destructive-foreground">Remove</Text>
                            </Pressable>
                          </View>
                        )}
                      </View>
                    );
                  })}
                </ScrollView>
              </View>
            </MotiView>
          </View>
        </MotiView>
      </Modal>

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
                  <View className="flex-row items-center gap-2">
                    <Pressable
                      className={`flex-row items-center gap-1 rounded-lg border px-2.5 py-1.5 ${loadingDirectories || creatingFolder ? "border-border/30 bg-card/50 opacity-60" : "border-border/50 bg-card"}`}
                      onPress={() => {
                        setPickerError(null);
                        if (showCreateFolderInput) {
                          setShowCreateFolderInput(false);
                          setNewFolderName("");
                          return;
                        }
                        setShowCreateFolderInput(true);
                      }}
                      disabled={loadingDirectories || creatingFolder}
                    >
                      <Ionicons
                        name={showCreateFolderInput ? "close-outline" : "add-outline"}
                        size={13}
                        className={loadingDirectories || creatingFolder ? "text-muted-foreground" : "text-foreground"}
                      />
                      <Text className={`text-xs font-medium ${loadingDirectories || creatingFolder ? "text-muted-foreground" : "text-foreground"}`}>
                        {showCreateFolderInput ? "Close" : "New"}
                      </Text>
                    </Pressable>
                    <Pressable
                      className={`flex-row items-center gap-1 rounded-lg px-2.5 py-1.5 ${parentDirectory && !creatingFolder ? "bg-card border border-border/50" : "opacity-40"}`}
                      onPress={() => {
                        if (parentDirectory) {
                          loadDirectory(parentDirectory).catch(() => undefined);
                        }
                      }}
                      disabled={!parentDirectory || loadingDirectories || creatingFolder}
                    >
                      <Ionicons
                        name="arrow-up-outline"
                        size={13}
                        className={parentDirectory && !creatingFolder ? "text-foreground" : "text-muted-foreground"}
                      />
                      <Text className={`text-xs font-medium ${parentDirectory && !creatingFolder ? "text-foreground" : "text-muted-foreground"}`}>
                        Up
                      </Text>
                    </Pressable>
                  </View>
                </View>

                {pickerError ? (
                  <View className="mt-2.5 flex-row items-center gap-2 rounded-xl bg-destructive/10 px-3 py-2.5">
                    <Ionicons name="alert-circle-outline" size={14} className="text-destructive" />
                    <Text className="flex-1 text-xs text-destructive-foreground">{pickerError}</Text>
                  </View>
                ) : null}

                {showCreateFolderInput ? (
                  <View className="mt-3 rounded-xl border border-border/40 bg-muted/40 px-3 py-3">
                    <Text className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">New Folder</Text>
                    <TextInput
                      value={newFolderName}
                      onChangeText={(value) => {
                        setNewFolderName(value);
                        if (pickerError) {
                          setPickerError(null);
                        }
                      }}
                      editable={!creatingFolder && !loadingDirectories}
                      autoFocus
                      autoCapitalize="none"
                      autoCorrect={false}
                      returnKeyType="done"
                      onSubmitEditing={() => {
                        if (!creatingFolder && !loadingDirectories && newFolderName.trim().length > 0) {
                          onCreateFolder().catch(() => undefined);
                        }
                      }}
                      placeholder="Folder name"
                      placeholderTextColor="rgba(148, 163, 184, 0.8)"
                      className="mt-2 rounded-lg border border-border/60 bg-card px-3 py-2.5 text-sm text-foreground"
                    />
                    <View className="mt-2.5 flex-row items-center justify-end gap-2">
                      <Pressable
                        className="rounded-lg border border-border/50 bg-muted px-3 py-2"
                        onPress={() => {
                          setShowCreateFolderInput(false);
                          setNewFolderName("");
                          setPickerError(null);
                        }}
                        disabled={creatingFolder}
                      >
                        <Text className="text-xs font-semibold text-foreground">Cancel</Text>
                      </Pressable>
                      <Pressable
                        className={`flex-row items-center gap-1 rounded-lg px-3 py-2 ${creatingFolder || loadingDirectories || newFolderName.trim().length === 0 ? "bg-primary/60" : "bg-primary"}`}
                        onPress={() => {
                          onCreateFolder().catch(() => undefined);
                        }}
                        disabled={creatingFolder || loadingDirectories || newFolderName.trim().length === 0}
                      >
                        {creatingFolder ? (
                          <ActivityIndicator size="small" className="text-primary-foreground" />
                        ) : (
                          <Ionicons name="add-outline" size={14} className="text-primary-foreground" />
                        )}
                        <Text className="text-xs font-semibold text-primary-foreground">
                          {creatingFolder ? "Creating..." : "Create"}
                        </Text>
                      </Pressable>
                    </View>
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
                          className={`mb-0.5 flex-row items-center justify-between rounded-lg bg-card/80 px-3 py-2.5 ${creatingFolder ? "opacity-60" : "active:bg-card"}`}
                          onPress={() => {
                            loadDirectory(item.path).catch(() => undefined);
                          }}
                          disabled={creatingFolder}
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
                    className={`flex-1 flex-row items-center justify-center gap-2 rounded-xl py-3 ${creating || creatingFolder || !currentDirectory ? "bg-primary/50" : "bg-primary"}`}
                    onPress={() => {
                      if (currentDirectory) {
                        onCreateThread(currentDirectory).catch(() => undefined);
                      }
                    }}
                    disabled={creating || creatingFolder || !currentDirectory}
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
                <View className="p-4">
                  <Text className="text-lg font-semibold text-card-foreground">Settings</Text>
                  <Text className="mt-1 text-xs text-muted-foreground">User info and pairing.</Text>

            <View className="mt-4 px-1">
              <Text className="text-xs text-muted-foreground">App version</Text>
              <Text className="mt-1 text-sm text-foreground">{appVersion}</Text>
            </View>

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
              <View className="flex-row mb-2 items-center gap-2">
                <Text className="text-xs text-muted-foreground">Paired devices</Text>
                <View className="rounded-full bg-primary/15 px-2 py-0.5">
                  <Text className="text-[10px] font-semibold text-primary">{pairedDevices.length} devices</Text>
                </View>
              </View>
              {pairedDevices.length === 0 ? (
                <Text className="mt-1 text-sm text-foreground">No active devices</Text>
              ) : (
                <ScrollView
                  className="mt-1"
                  style={{ maxHeight: devicesListMaxHeight }}
                  contentContainerStyle={{ gap: 8, paddingRight: 4 }}
                  showsVerticalScrollIndicator
                  nestedScrollEnabled
                >
                  {pairedDevices.map((device) => (
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
                </ScrollView>
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
                    onPress={() => {
                      setShowSettingsMenu(false);
                      router.push("/pair");
                    }}
                  >
                    <View className="flex-row items-center justify-center gap-2">
                      <Ionicons name="link-outline" size={16} className="text-foreground" />
                      <Text className="text-sm font-semibold text-foreground">Add Gateway</Text>
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
                </View>
              </View>
            </MotiView>
          </View>
        </MotiView>
      </Modal>
    </SafeAreaView>
  );
}
