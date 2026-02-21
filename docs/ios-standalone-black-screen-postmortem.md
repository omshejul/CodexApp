# iOS Standalone Black Screen Postmortem

## Summary
The app worked in Expo Go, but showed a black/blank screen when run as a local standalone iOS build (`Release`) from Xcode/Expo.

## Symptoms
- App launched, but UI looked fully black or blank.
- In some runs, app opened and closed quickly.
- `No script URL provided` appeared when trying to run without Metro and without an embedded bundle.
- Snapshot-related logs appeared:
  - `FBSSceneSnapshotErrorDomain code: 4`

## Root Cause
The primary root cause was style initialization not being applied correctly for standalone routing screens:
- Screens (`pair`, `threads`, `thread/[id]`) rely on NativeWind `className` tokens and theme variables.
- `global.css` was not imported at root layout level, so theme variables/classes were not reliably available in the standalone startup path.
- Result: screens could render as effectively blank/black in release builds.

There was a secondary config pitfall during debugging:
- `nativewind/babel` placement was changed incorrectly once and caused bundling failure (`.plugins is not a valid Plugin property`).
- For this project version, `nativewind/babel` must be in `presets`.

## What We Changed
- Updated `/Users/omshejul/Code/CodexApp/app/app/_layout.tsx`:
  - Added `import "../global.css";`
- Confirmed `/Users/omshejul/Code/CodexApp/app/babel.config.js` is:
  - `presets: ["babel-preset-expo", "nativewind/babel"]`
  - `plugins: ["react-native-reanimated/plugin"]`
- Used a temporary diagnostic index screen to isolate routing and rendering behavior, then removed it.
- Restored normal startup routing in `/Users/omshejul/Code/CodexApp/app/app/index.tsx`:
  - Route to `/threads` if paired, else `/pair`.

## Verification
- Local release build command used:
  - `npx expo run:ios --device --configuration Release`
- After fixes:
  - Pairing screen worked.
  - Full app flow worked on device.
  - Manual diagnostic page was removed after verification.

## Lessons Learned
- Expo Go success does not guarantee standalone release success.
- NativeWind/Tailwind setup must be complete for standalone startup:
  - root CSS import is critical.
  - Babel config shape must match installed NativeWind version.
- For true standalone checks, always test release builds:
  - `npx expo run:ios --device --configuration Release`
- `FBSSceneSnapshotErrorDomain` logs are usually not the root cause for blank screen issues.
- `No script URL provided` means either:
  - Metro is not running for debug builds, or
  - standalone bundle was not embedded correctly.

## Operational Checklist (Future)
1. Run `expo-doctor` and resolve dependency/config mismatches.
2. Validate `app/app/_layout.tsx` imports `../global.css`.
3. Validate `babel.config.js` NativeWind/Reanimated order and placement.
4. Build and test on real device in `Release`.
5. Add temporary minimal screen only if needed for isolation, then remove it.
