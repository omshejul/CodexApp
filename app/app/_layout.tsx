import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { Platform } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import "../global.css";
import "../lib/interop";

const SYSTEM_FONT = Platform.select({
  ios: "System",
  android: "sans-serif",
  default: "System",
});

export default function RootLayout() {
  useEffect(() => {
    SplashScreen.hideAsync().catch(() => undefined);
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" backgroundColor="hsl(0, 0%, 4%)" />
      <Stack
        initialRouteName="index"
        screenOptions={{
          headerShown: false,
          contentStyle: {
            backgroundColor: "hsl(0, 0%, 4%)",
          },
          headerTitleStyle: {
            fontWeight: "700",
            fontFamily: SYSTEM_FONT,
          },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="pair" options={{ title: "Pair Device", headerShown: false }} />
        <Stack.Screen name="threads" options={{ title: "Threads", headerShown: false }} />
        <Stack.Screen name="thread/[id]" options={{ title: "Thread", headerShown: false }} />
      </Stack>
    </SafeAreaProvider>
  );
}
