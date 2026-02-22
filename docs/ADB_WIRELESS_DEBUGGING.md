# Wireless ADB Quick Memory

Use this when Android wireless debugging does not reconnect automatically.

## Why the port changes

- Wireless ADB exposes a dynamic TLS connect port (`_adb-tls-connect._tcp`).
- The port shown on device can change across reconnects, Wi-Fi changes, or ADB restarts.
- This is expected behavior.

## Reconnect commands

```bash
adb start-server
adb connect "$(adb mdns services | awk '/_adb-tls-connect._tcp/ {print $3; exit}')"
adb devices -l
```

## If reconnect fails

```bash
adb disconnect
adb kill-server
adb start-server
adb connect "$(adb mdns services | awk '/_adb-tls-connect._tcp/ {print $3; exit}')"
adb devices -l
```

## Pairing reminder

- Pairing (`adb pair host:port`) and connecting (`adb connect host:port`) use different ports.
- If pairing expires, pair again from Developer Options and then reconnect.
