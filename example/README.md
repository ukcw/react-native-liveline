# Example App

This Expo app matches the Liveline dev screen used in the app repo:

- Live crypto-like feed
- Line chart with window controls (`30s`, `1m`, `5m`)
- Momentum visuals and scrubbing
- Scrub haptics (one tick per hovered index change)
- Pinned to Expo SDK 54 for Expo Go compatibility

## Run locally

```bash
cd example
rm -rf node_modules bun.lock .expo
bun pm trust @shopify/react-native-skia
bun install
bun run start -c
```

This app imports Liveline directly from the local repo source (`../src`) so example behavior always matches the latest in-repo changes.

If you see a Reanimated runtime error in Expo Go, make sure you are on the latest Expo Go app and that dependencies are reinstalled from this `package.json` (especially exact `react-native-reanimated` and `react-native-worklets` versions).
