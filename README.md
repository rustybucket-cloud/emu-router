# emu-router

Routes Expo dev servers to a pool of Android emulators. Each `emu-router start` gets its own emulator and Metro port. If every emulator is in use, it boots a stopped one or creates a new one, as long as the running cap allows. Otherwise it waits in a queue.

## Setup

```sh
npm install
npm link        # puts `emu-router` on your PATH
```

Requires Node ≥ 22.18 (runs the TypeScript directly) and the Android SDK (`ANDROID_HOME`, default `~/Library/Android/sdk`).

## Use

In an Expo project:

```sh
emu-router start            # instead of `npx expo start`; extra args pass through
emu-router start --dev-client
```

Other commands:

```sh
emu-router ui               # dashboard at http://127.0.0.1:7777
emu-router status
emu-router cap 3            # at most 3 pool emulators running at once
emu-router shutdown         # stops the daemon; emulators keep running
```

The daemon starts automatically on first use.

## How it works

- **Daemon** (`src/pool.ts`) tracks every AVD in `~/.android/avd` and every emulator `adb` can see, polling every 3s. It hands out **leases** (one per Expo server) oldest first. It prefers an idle running emulator, then boots a stopped one, then creates a new one.
- **New emulators** (`emu-router-N`) copy the template AVD's hardware profile and system image, but not its disk. They start clean, and creating one is instant. If the system image is missing, it's installed with `sdkmanager`, which needs Android Studio's Command-line Tools.
- **Opening the app**: once Metro is up, the daemon runs `adb reverse` for the lease's port and opens the app:
  - **Expo Go:** opens `exp://127.0.0.1:<port>`, installing the matching Expo Go first if it's missing.
  - **Dev client:** opens `exp+<slug>://expo-development-client/?url=…`. If the emulator doesn't have the dev build yet, the router installs the debug APK from your last `expo run:android` (`android/app/build/outputs/apk/debug`). If there's no APK, build one with `npx expo run:android`.
  - **Anything else:** set `EMU_ROUTER_URL` (with `{port}` as a placeholder).
- **Leases** end when Expo exits, or when the CLI stops heartbeating (30s, or right away if its process dies). The emulator stays warm for the next server unless idle shutdown is set.
- **If an emulator dies** mid-session, its lease is requeued and the app reopens on the next emulator it gets.

## Notes

- Don't use Expo's `a` key; it opens on whichever device adb lists first. Use **Reopen app** in the dashboard.
- Emulators you start yourself (e.g. from Android Studio) show as *started externally*. They can be leased and count toward the cap, but the router never shuts them down on its own. Toggle **In pool** off to keep one out of rotation.
- State lives in `~/.emu-router/`: config, daemon log, emulator logs, and the Expo Go APK cache.
