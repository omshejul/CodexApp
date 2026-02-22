import { Platform } from "react-native";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { hasStoredPairing, upsertPushToken } from "@/lib/api";

let notificationHandlerConfigured = false;
let lastRegisteredToken: string | null = null;

export function configurePushNotifications() {
  if (notificationHandlerConfigured) {
    return;
  }
  notificationHandlerConfigured = true;

  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}

function resolveExpoProjectId(): string | null {
  const easProjectId = Constants.expoConfig?.extra?.eas?.projectId;
  if (typeof easProjectId === "string" && easProjectId.trim().length > 0) {
    return easProjectId.trim();
  }

  const legacyProjectId = Constants.easConfig?.projectId;
  if (typeof legacyProjectId === "string" && legacyProjectId.trim().length > 0) {
    return legacyProjectId.trim();
  }

  return null;
}

export async function registerPushTokenWithGatewayIfPossible() {
  if (!(await hasStoredPairing())) {
    return;
  }
  if (!Device.isDevice) {
    return;
  }
  if (Platform.OS !== "ios" && Platform.OS !== "android") {
    return;
  }

  const existingPermission = await Notifications.getPermissionsAsync();
  let finalStatus = existingPermission.status;
  if (finalStatus !== "granted") {
    const requestedPermission = await Notifications.requestPermissionsAsync();
    finalStatus = requestedPermission.status;
  }
  if (finalStatus !== "granted") {
    return;
  }

  const projectId = resolveExpoProjectId();
  if (!projectId) {
    return;
  }

  const expoPushToken = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  if (!expoPushToken || expoPushToken === lastRegisteredToken) {
    return;
  }

  await upsertPushToken({
    token: expoPushToken,
    platform: Platform.OS,
    enabled: true,
  });
  lastRegisteredToken = expoPushToken;
}
