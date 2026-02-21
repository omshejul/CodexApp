import { useEffect } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { router } from "expo-router";
import { hasStoredPairing } from "@/lib/api";

export default function IndexScreen() {
  useEffect(() => {
    let mounted = true;

    const routeToInitialScreen = async () => {
      try {
        const isPaired = await hasStoredPairing();
        if (!mounted) {
          return;
        }
        router.replace(isPaired ? "/threads" : "/pair");
      } catch {
        if (!mounted) {
          return;
        }
        router.replace("/pair");
      }
    };

    routeToInitialScreen().catch(() => {
      router.replace("/pair");
    });

    return () => {
      mounted = false;
    };
  }, []);

  return (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#000000",
        paddingHorizontal: 24,
      }}
    >
      <Text style={{ color: "#ffffff", fontSize: 28, fontWeight: "700" }}>Codex Phone</Text>
      <Text style={{ marginTop: 10, color: "#c9d4e5", fontSize: 15, textAlign: "center" }}>Starting…</Text>
      <ActivityIndicator size="large" color="#22c55e" style={{ marginTop: 16 }} />
    </View>
  );
}
