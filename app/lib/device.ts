import { Platform } from "react-native";
import * as Device from "expo-device";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";

const DEVICE_ID_KEY = "codex_phone_device_id";

export interface DeviceIdentity {
  deviceId: string;
  deviceName: string;
}

export async function getOrCreateDeviceIdentity(): Promise<DeviceIdentity> {
  let deviceId = await SecureStore.getItemAsync(DEVICE_ID_KEY);
  if (!deviceId) {
    deviceId = Crypto.randomUUID();
    await SecureStore.setItemAsync(DEVICE_ID_KEY, deviceId);
  }

  const deviceName = Device.deviceName || Device.modelName || `${Platform.OS}-phone`;

  return {
    deviceId,
    deviceName,
  };
}
