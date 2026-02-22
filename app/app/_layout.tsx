import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { Alert, Platform } from "react-native";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import "../global.css";
import "../lib/interop";
import {
  configurePushNotifications,
  PushNotificationsSetupError,
  registerPushTokenWithGatewayIfPossible,
} from "@/lib/push-notifications";

const SYSTEM_FONT = Platform.select({
  ios: "System",
  android: "sans-serif",
  default: "System",
});
let didShowPushSetupAlert = false;
const reportedPushSetupCodes = new Set<PushNotificationsSetupError["code"]>();

function reportPushSetupError(error: unknown) {
  if (error instanceof PushNotificationsSetupError) {
    if (!reportedPushSetupCodes.has(error.code)) {
      reportedPushSetupCodes.add(error.code);
      console.warn("Push notifications setup issue", error.message);
    }
    const shouldShowAlert = error.code !== "gateway-route-missing";
    if (__DEV__ && shouldShowAlert && !didShowPushSetupAlert) {
      didShowPushSetupAlert = true;
      Alert.alert("Push setup issue", error.message);
    }
    return;
  }

  const fallbackMessage = error instanceof Error ? error.message : "Unknown push setup error";
  console.error("Push notifications setup failed", error);
  if (__DEV__ && !didShowPushSetupAlert) {
    didShowPushSetupAlert = true;
    Alert.alert("Push setup issue", fallbackMessage);
  }
}

export default function RootLayout() {
  useEffect(() => {
    SplashScreen.hideAsync().catch(() => undefined);
    try {
      configurePushNotifications();
    } catch (error) {
      reportPushSetupError(error);
    }
    registerPushTokenWithGatewayIfPossible().catch((error) => {
      reportPushSetupError(error);
    });
  }, []);

  return (
    <SafeAreaProvider>
      <KeyboardProvider>
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
      </KeyboardProvider>
    </SafeAreaProvider>
  );
}
