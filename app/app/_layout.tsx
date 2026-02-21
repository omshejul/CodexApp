import "../global.css";
import { Stack } from "expo-router";
import { Platform } from "react-native";

const SYSTEM_FONT = Platform.select({
  ios: "System",
  android: "sans-serif",
  default: "System",
});

export default function RootLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: {
          backgroundColor: "#090f1a",
        },
        headerTintColor: "#d7e9ff",
        headerTitleStyle: {
          fontWeight: "700",
          color: "#d7e9ff",
          fontFamily: SYSTEM_FONT,
        },
        contentStyle: {
          backgroundColor: "#090f1a",
        },
      }}
    >
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="pair" options={{ title: "Pair Device", headerShown: false }} />
      <Stack.Screen name="threads" options={{ title: "Threads" }} />
      <Stack.Screen name="thread/[id]" options={{ title: "Thread", headerShown: false }} />
    </Stack>
  );
}
