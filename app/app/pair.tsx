import { useMemo, useRef, useState } from "react";
import { ActivityIndicator, Modal, Pressable, Text, TextInput, View } from "react-native";
import { CameraView, BarcodeScanningResult, useCameraPermissions } from "expo-camera";
import { router } from "expo-router";
import { MotiView } from "moti";
import { SafeAreaView } from "react-native-safe-area-context";
import { claimPairing, getGatewayById, parsePairingUrl, renameGateway } from "@/lib/api";
import { getOrCreateDeviceIdentity } from "@/lib/device";
import { registerPushTokenWithGatewayIfPossible } from "@/lib/push-notifications";
import { sendActivePresenceNowIfPaired } from "@/lib/app-presence";

const MAX_NICKNAME_LENGTH = 40;

export default function PairScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showNicknamePrompt, setShowNicknamePrompt] = useState(false);
  const [pendingGatewayId, setPendingGatewayId] = useState<string | null>(null);
  const [defaultNickname, setDefaultNickname] = useState("");
  const [nicknameDraft, setNicknameDraft] = useState("");
  const [finalizingPair, setFinalizingPair] = useState(false);
  const scanInFlightRef = useRef(false);

  const canScan = useMemo(
    () => !!permission?.granted && !busy && !finalizingPair && !showNicknamePrompt,
    [permission?.granted, busy, finalizingPair, showNicknamePrompt]
  );

  const completePairing = async () => {
    if (!pendingGatewayId || finalizingPair) {
      return;
    }

    setFinalizingPair(true);
    setError(null);
    try {
      const fallbackNickname = defaultNickname.trim() || "Gateway";
      const nextNickname = nicknameDraft.trim() || fallbackNickname;
      await renameGateway(pendingGatewayId, nextNickname.slice(0, MAX_NICKNAME_LENGTH));

      await registerPushTokenWithGatewayIfPossible().catch((pushError) => {
        const message = pushError instanceof Error ? pushError.message : "Unknown push token error";
        console.warn("Push token registration skipped", message);
      });
      await sendActivePresenceNowIfPaired().catch((presenceError) => {
        const message = presenceError instanceof Error ? presenceError.message : "Unknown app presence error";
        console.warn("App presence sync skipped", message);
      });

      setShowNicknamePrompt(false);
      setPendingGatewayId(null);
      router.replace("/threads");
    } catch (finalizeError) {
      const message = finalizeError instanceof Error ? finalizeError.message : "Unable to finish pairing.";
      setError(message);
    } finally {
      setFinalizingPair(false);
    }
  };

  const onScan = async (result: BarcodeScanningResult) => {
    if (!canScan || scanInFlightRef.current) {
      return;
    }

    scanInFlightRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const parsed = parsePairingUrl(result.data);
      const identity = await getOrCreateDeviceIdentity();
      const claimed = await claimPairing(parsed, identity);
      const pairedGateway = await getGatewayById(claimed.gatewayId);
      const fallbackNickname = pairedGateway?.host?.trim() || parsed.serverBaseUrl;
      const initialNickname = pairedGateway?.nickname?.trim() || fallbackNickname;
      setPendingGatewayId(claimed.gatewayId);
      setDefaultNickname(fallbackNickname.slice(0, MAX_NICKNAME_LENGTH));
      setNicknameDraft(initialNickname.slice(0, MAX_NICKNAME_LENGTH));
      setShowNicknamePrompt(true);
    } catch (scanError) {
      const message = scanError instanceof Error ? scanError.message : "Unable to pair device.";
      setError(message);
      setBusy(false);
      scanInFlightRef.current = false;
      return;
    }

    setBusy(false);
    scanInFlightRef.current = false;
  };

  return (
    <SafeAreaView className="flex-1 bg-background px-5 py-3" edges={["top", "bottom", "left", "right"]}>
      <MotiView
        from={{ opacity: 0, translateY: 12 }}
        animate={{ opacity: 1, translateY: 0 }}
        transition={{ type: "timing", duration: 260 }}
        className="w-full flex-1"
      >
        <Text className="text-3xl font-semibold text-foreground">Codex Phone</Text>
        <Text className="mt-2 text-base leading-6 text-muted-foreground">
          Pair once, then your phone connects to your mac threads instantly.
        </Text>

        {permission?.granted ? (
          <View className="relative mt-5 overflow-hidden rounded-2xl border border-border/50 bg-card">
            <CameraView
              style={{ width: "100%", height: 420 }}
              onBarcodeScanned={canScan ? onScan : undefined}
              barcodeScannerSettings={{
                barcodeTypes: ["qr"],
              }}
            />
            {busy ? (
              <View className="absolute inset-0 items-center justify-center bg-background/60">
                <ActivityIndicator size="large" />
                <Text className="mt-3 text-sm font-medium text-foreground">Pairing device...</Text>
              </View>
            ) : null}
          </View>
        ) : (
          <View className="mt-5 rounded-2xl bg-muted p-4">
            <Text className="text-sm text-muted-foreground">
              This app uses one-time pairing. Your Codex server stays local on your Mac and is only reachable via your own secure Tailscale tunnel.
            </Text>
          </View>
        )}

        {error ? (
          <View className="mt-4 rounded-xl border border-border/50 bg-destructive/15 p-3">
            <Text className="text-sm font-medium text-destructive-foreground">{error}</Text>
          </View>
        ) : null}

        <View className="mt-auto pb-2">
          <Text className="text-center text-sm text-muted-foreground">
            Open this on your mac:
          </Text>
          <Text className="mt-1 text-center text-base font-semibold text-foreground">http://127.0.0.1:8787/pair</Text>

          <View className="mt-4 flex-row gap-3">
            {!permission?.granted ? (
              <Pressable
                onPress={requestPermission}
                className="flex-1 rounded-xl bg-primary px-4 py-3"
              >
                <Text className="text-center text-base font-bold text-primary-foreground">Enable Camera</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      </MotiView>

      <Modal transparent visible={showNicknamePrompt} animationType="fade">
        <View className="flex-1 items-center justify-center bg-background/80 px-5">
          <View className="w-full rounded-2xl border border-border/50 bg-card p-5">
            <Text className="text-lg font-semibold text-card-foreground">Name this gateway</Text>
            <Text className="mt-1 text-sm text-muted-foreground">
              Add a nickname so you can switch between multiple Macs.
            </Text>
            <TextInput
              value={nicknameDraft}
              onChangeText={setNicknameDraft}
              editable={!finalizingPair}
              maxLength={MAX_NICKNAME_LENGTH}
              placeholder={defaultNickname || "Gateway"}
              placeholderTextColor="rgba(148, 163, 184, 0.8)"
              className="mt-4 rounded-xl border border-border/60 bg-muted px-3 py-3 text-base text-foreground"
            />
            <Text className="mt-2 text-xs text-muted-foreground">
              Leave blank to use: {defaultNickname || "Gateway"}
            </Text>
            <Pressable
              onPress={() => {
                completePairing().catch(() => undefined);
              }}
              disabled={finalizingPair}
              className={`mt-4 rounded-xl px-4 py-3 ${finalizingPair ? "bg-primary/60" : "bg-primary"}`}
            >
              {finalizingPair ? (
                <ActivityIndicator size="small" color="#ffffff" />
              ) : (
                <Text className="text-center text-base font-semibold text-primary-foreground">Continue</Text>
              )}
            </Pressable>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}
