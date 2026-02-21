import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { CameraView, BarcodeScanningResult, useCameraPermissions } from "expo-camera";
import { router } from "expo-router";
import { MotiView } from "moti";
import { claimPairing, parsePairingUrl } from "@/lib/api";
import { getOrCreateDeviceIdentity } from "@/lib/device";

export default function PairScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canScan = useMemo(() => !!permission?.granted && scanning && !busy, [permission?.granted, scanning, busy]);

  const onScan = async (result: BarcodeScanningResult) => {
    if (!canScan) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const parsed = parsePairingUrl(result.data);
      const identity = await getOrCreateDeviceIdentity();
      await claimPairing(parsed, identity);
      router.replace("/threads");
    } catch (scanError) {
      const message = scanError instanceof Error ? scanError.message : "Unable to pair device.";
      setError(message);
      setBusy(false);
      setScanning(false);
      return;
    }

    setBusy(false);
    setScanning(false);
  };

  return (
    <View className="flex-1 bg-[#f6f9ff] px-5 pt-12">
      <MotiView
        from={{ opacity: 0, translateY: 12 }}
        animate={{ opacity: 1, translateY: 0 }}
        transition={{ type: "timing", duration: 260 }}
        className="rounded-3xl border border-[#d9ecff] bg-white p-5"
      >
        <Text className="text-3xl font-black text-[#14335f]">Codex Phone</Text>
        <Text className="mt-2 text-base leading-6 text-[#365f89]">
          Scan the pairing QR from your laptop at <Text className="font-bold">http://127.0.0.1:8787/pair</Text>.
        </Text>

        {permission?.granted && scanning ? (
          <View className="mt-4 overflow-hidden rounded-2xl border border-[#c5def9]">
            <CameraView
              style={{ width: "100%", height: 360 }}
              onBarcodeScanned={onScan}
              barcodeScannerSettings={{
                barcodeTypes: ["qr"],
              }}
            />
          </View>
        ) : (
          <View className="mt-4 rounded-2xl bg-[#eef5ff] p-4">
            <Text className="text-sm text-[#365f89]">
              This app uses one-time pairing. Your Codex server stays local on the laptop and is only reachable through your own Tailscale tunnel.
            </Text>
          </View>
        )}

        {error ? (
          <View className="mt-4 rounded-xl border border-[#f1b7b7] bg-[#fff4f4] p-3">
            <Text className="text-sm font-medium text-[#a42f2f]">{error}</Text>
          </View>
        ) : null}

        <View className="mt-5 flex-row gap-3">
          {!permission?.granted ? (
            <Pressable
              onPress={requestPermission}
              className="flex-1 rounded-xl bg-[#2f7de1] px-4 py-3"
            >
              <Text className="text-center text-base font-bold text-white">Enable Camera</Text>
            </Pressable>
          ) : (
            <Pressable
              onPress={() => setScanning((value) => !value)}
              disabled={busy}
              className="flex-1 rounded-xl bg-[#2f7de1] px-4 py-3"
            >
              <Text className="text-center text-base font-bold text-white">
                {scanning ? (busy ? "Pairing…" : "Stop") : "Scan QR"}
              </Text>
            </Pressable>
          )}
        </View>
      </MotiView>
    </View>
  );
}
