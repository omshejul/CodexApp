import { useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { CameraView, BarcodeScanningResult, useCameraPermissions } from "expo-camera";
import { router } from "expo-router";
import { MotiView } from "moti";
import { SafeAreaView } from "react-native-safe-area-context";
import { claimPairing, parsePairingUrl } from "@/lib/api";
import { getOrCreateDeviceIdentity } from "@/lib/device";
import { registerPushTokenWithGatewayIfPossible } from "@/lib/push-notifications";
import { sendActivePresenceNowIfPaired } from "@/lib/app-presence";

export default function PairScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scanInFlightRef = useRef(false);

  const canScan = useMemo(() => !!permission?.granted && !busy, [permission?.granted, busy]);

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
      await claimPairing(parsed, identity);
      await registerPushTokenWithGatewayIfPossible().catch((pushError) => {
        const message = pushError instanceof Error ? pushError.message : "Unknown push token error";
        console.warn("Push token registration skipped", message);
      });
      await sendActivePresenceNowIfPaired().catch((presenceError) => {
        const message = presenceError instanceof Error ? presenceError.message : "Unknown app presence error";
        console.warn("App presence sync skipped", message);
      });
      router.replace("/threads");
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
              onBarcodeScanned={busy ? undefined : onScan}
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
    </SafeAreaView>
  );
}
