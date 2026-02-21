import "../global.css";
import { Stack } from "expo-router";

export default function RootLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: {
          backgroundColor: "#f6f9ff",
        },
        headerTintColor: "#14335f",
        headerTitleStyle: {
          fontWeight: "700",
        },
        contentStyle: {
          backgroundColor: "#f6f9ff",
        },
      }}
    >
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="pair" options={{ title: "Pair Device", headerShown: false }} />
      <Stack.Screen name="threads" options={{ title: "Threads" }} />
      <Stack.Screen name="thread/[id]" options={{ title: "Thread" }} />
    </Stack>
  );
}
