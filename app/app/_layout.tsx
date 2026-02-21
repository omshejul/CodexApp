import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { Platform } from "react-native";
import "../global.css";

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
    <>
      <StatusBar style="light" backgroundColor="#0a0a0a" />
      <Stack
        initialRouteName="index"
        screenOptions={{
          headerShown: false,
          contentStyle: {
            backgroundColor: "#ffffff",
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
    </>
  );
}
