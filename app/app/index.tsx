import { useEffect } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { router } from "expo-router";
import { MotiView } from "moti";
import { hasStoredPairing, ReauthRequiredError, authenticatedRequest } from "@/lib/api";

export default function IndexScreen() {
  useEffect(() => {
    const bootstrap = async () => {
      const hasPairing = await hasStoredPairing();
      if (!hasPairing) {
        router.replace("/pair");
        return;
      }

      try {
        await authenticatedRequest("/threads", { method: "GET" });
        router.replace("/threads");
      } catch (error) {
        if (error instanceof ReauthRequiredError) {
          router.replace("/pair");
          return;
        }
        router.replace("/threads");
      }
    };

    bootstrap().catch(() => {
      router.replace("/pair");
    });
  }, []);

  return (
    <View className="flex-1 items-center justify-center bg-background px-6">
      <MotiView
        from={{ opacity: 0, translateY: 6 }}
        animate={{ opacity: 1, translateY: 0 }}
        transition={{ type: "timing", duration: 280 }}
        className="items-center"
      >
        <ActivityIndicator size="large" color="#22c55e" />
        <Text className="mt-3 text-base font-semibold text-foreground">Connecting to your laptop…</Text>
      </MotiView>
    </View>
  );
}
