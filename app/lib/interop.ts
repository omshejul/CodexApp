import { cssInterop } from "nativewind";
import { Ionicons } from "@expo/vector-icons";
import { ActivityIndicator, RefreshControl } from "react-native";

/**
 * Map className → style → color prop so we can write:
 *   <Ionicons className="text-primary" … />
 *   <ActivityIndicator className="text-primary" … />
 *   <RefreshControl className="text-primary" … />
 * instead of hard-coding hex colour strings.
 */
cssInterop(Ionicons, {
  className: {
    target: "style",
    nativeStyleToProp: { color: true },
  },
});

cssInterop(ActivityIndicator, {
  className: {
    target: "style",
    nativeStyleToProp: { color: true },
  },
});

cssInterop(RefreshControl, {
  className: {
    target: "style",
    nativeStyleToProp: { color: "tintColor" },
  },
});
