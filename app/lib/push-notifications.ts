import { Platform } from "react-native";
import Constants from "expo-constants";
import * as Device from "expo-device";
import { ApiHttpError, hasStoredPairing, upsertPushToken } from "@/lib/api";

type NotificationsModule = typeof import("expo-notifications");
export class PushNotificationsSetupError extends Error {
  code: "native-module-missing" | "project-id-missing" | "gateway-route-missing";

  constructor(code: PushNotificationsSetupError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "PushNotificationsSetupError";
  }
}

let notificationHandlerConfigured = false;
let lastRegisteredToken: string | null = null;
let notificationsModule: NotificationsModule | null | undefined;
let missingNativeModuleWarned = false;

function isMobilePlatform(): boolean {
  return Platform.OS === "ios" || Platform.OS === "android";
}

function handleMissingNativeModule(requireNativeModule: boolean): null {
  const message =
    "expo-notifications native module is unavailable. Rebuild/reinstall the dev client to enable push notifications.";
  if (!missingNativeModuleWarned) {
    missingNativeModuleWarned = true;
    console.warn(message);
  }
  if (requireNativeModule) {
    throw new PushNotificationsSetupError("native-module-missing", message);
  }
  return null;
}

function getNotificationsModule(requireNativeModule: boolean): NotificationsModule | null {
  if (notificationsModule !== undefined) {
    return notificationsModule;
  }

  try {
    notificationsModule = require("expo-notifications") as NotificationsModule;
    return notificationsModule;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const missingNativeModule =
      message.includes("ExpoPushTokenManager") ||
      message.includes("ExpoNotificationsEmitter") ||
      message.includes("Cannot find native module");
    if (!missingNativeModule && requireNativeModule) {
      throw error;
    }
    notificationsModule = null;
    if (missingNativeModule) {
      handleMissingNativeModule(requireNativeModule);
    } else if (!missingNativeModuleWarned) {
      missingNativeModuleWarned = true;
      console.warn("Unable to load expo-notifications module.", message);
    }
    return null;
  }
}

function isGatewayMissingPushTokenRouteError(error: unknown): boolean {
  if (!(error instanceof ApiHttpError)) {
    return false;
  }
  if (error.status !== 404) {
    return false;
  }
  return error.body.includes("POST:/notifications/push-token") && error.body.includes("not found");
}

export function configurePushNotifications() {
  if (notificationHandlerConfigured) {
    return;
  }
  notificationHandlerConfigured = true;
  const Notifications = getNotificationsModule(Device.isDevice && isMobilePlatform());
  if (!Notifications) {
    return;
  }

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
  const platform = Platform.OS;
  if (platform !== "ios" && platform !== "android") {
    return;
  }
  if (!Device.isDevice) {
    return;
  }
  const Notifications = getNotificationsModule(true);
  if (!Notifications) {
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
    throw new PushNotificationsSetupError(
      "project-id-missing",
      "Missing EAS projectId in app config. Set expo.extra.eas.projectId in app/app.json."
    );
  }

  const expoPushToken = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  if (!expoPushToken || expoPushToken === lastRegisteredToken) {
    return;
  }

  try {
    await upsertPushToken({
      token: expoPushToken,
      platform,
      enabled: true,
    });
  } catch (error) {
    if (isGatewayMissingPushTokenRouteError(error)) {
      throw new PushNotificationsSetupError(
        "gateway-route-missing",
        "Your Mac gateway is outdated and missing push token support. Rebuild/restart CodexGateway on your Mac."
      );
    }
    throw error;
  }
  lastRegisteredToken = expoPushToken;
}
