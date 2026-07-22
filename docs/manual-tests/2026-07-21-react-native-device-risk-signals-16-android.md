# Android physical-device manual test for issue #16

This guide covers the manual evidence required for
[`AfanasievN/react-native-device-risk-signals#16`](https://github.com/AfanasievN/react-native-device-risk-signals/issues/16),
“Add the first sanitized Android physical-device compatibility report.”

The test must use:

- a **released npm package**, not unreleased source from `main`;
- a **physical Android device**, not an emulator, simulator, or hosted device farm;
- React Native with the **New Architecture enabled**;
- a sanitized status-only report that does not expose the raw signal payload.

This procedure pins the currently released package and reviewed example harness:

| Item | Exact value |
| --- | --- |
| npm package | `react-native-device-risk-signals@0.5.1` |
| React Native | `0.86.0` |
| Example-harness commit | `116ec590fb8e4f68683d674282b5b9371b91085f` (release tag `v0.5.1`) |
| Application build | Debug |
| Matrix validation level | `Community reported` |

Do not substitute newer values silently. If the package, issue, or repository has moved before the
test is performed, stop and have the operator refresh this guide.

## What counts as success

The manual run is usable evidence when all of the following are true:

1. The installed dependency resolves to the registry release `0.5.1`, not `file:..` or repository
   source.
2. The app is installed on a real Android phone or tablet.
3. `newArchEnabled=true` is present, and the collected `runtime` probe reports
   `isFabric: true` and `isTurboModule: true`. On React Native `0.86.0`, `isBridgeless: true` is
   also expected and should be recorded, but it is not the sole New Architecture criterion.
4. Tapping **Collect device signals** completes and shows **Latest collection** and **Ready**.
5. Every returned probe is recorded only as `success`, `skipped`, `timeout`, or `error`.
6. A second collection completes so the result is reproducible. If the two runs differ, preserve
   both results instead of choosing the better one.
7. The final report contains the package version, React Native version, Android version, coarse
   public device model, Debug build type, and sanitized probe outcomes.

An individual `skipped`, `timeout`, or `error` outcome does **not** automatically invalidate the
report. Optional fields can be unavailable because of the OS version, hardware, permissions, or app
state. Record the outcome accurately; do not reinterpret it as a security or detection verdict.

## Privacy rules before doing anything

The example app keeps the event local, but its **Raw JSON** panel can contain high-entropy or
sensitive values. The event can include an ephemeral session ID, build fingerprints, font digests,
certificate hashes, local IP addresses, network details, location data, app state, and other signal
values.

Follow these rules throughout the test:

- Prefer a spare/test stock device rather than a personal production phone.
- Do not use a device containing customer, account, transaction, or production data.
- Turn on Do Not Disturb so notifications do not appear in screenshots.
- Never take, upload, or post a screenshot of the complete Raw JSON event.
- Never save or share the output of `adb devices`; it contains a stable device serial.
- Never report IMEI, Android ID, device serial, account identifiers, credentials, precise location,
  Wi-Fi SSID/BSSID, local addresses, certificate hashes, font digests, full build fingerprints, or
  unrelated raw values.
- Record probe **status** only. For a non-success status, include only the shortest sanitized reason
  needed to explain it.
- Review and crop every screenshot before it leaves the test machine.

Upstream does not require screenshots. The five screenshots below are a Northset evidence aid. They
must remain sanitized.

## Required screenshots

| File name | When to take it | What must be visible | What must not be visible |
| --- | --- | --- | --- |
| `01-environment.png` | After Step 4 | Package `0.5.1`, RN `0.86.0`, nonsymlinked dependency, `newArchEnabled=true`, Android version/API, coarse manufacturer/model, `build_type=Debug` | ADB serial, username/path, notifications, account data |
| `02-before-collection.png` | After the app opens | **Inspect this device**, Android badge, **Local inspection**, and **Collect device signals** | Raw JSON or notifications |
| `03-first-summary.png` | After collection 1 | **Latest collection**, **Ready**, observed/skipped/failed counts, and duration | Raw JSON values |
| `04-runtime-new-architecture.png` | While viewing only the `runtime` probe | `runtime`, `status: success`, `isFabric: true`, `isTurboModule: true`, `isBridgeless: true`, RN version, Android platform, Debug state | `session_id`, another probe, or any unrelated payload value |
| `05-second-summary.png` | After collection 2 | The second **Latest collection** summary and duration | Raw JSON values |

If collection displays the top-level **Collection failed** panel, take one additional screenshot named
`failure-collection-panel.png`, stop the success procedure, and follow the failure instructions near
the end of this guide.

## Step 1: prepare the host machine

Use the official setup references if Android tooling is not already installed:

- [React Native environment setup](https://reactnative.dev/docs/next/set-up-your-environment)
- [Android: enable developer options and USB debugging](https://developer.android.com/studio/debug/dev-options)
- [Android: run an app on a physical device](https://developer.android.com/studio/run/device)

Required host tooling:

- Node.js `22.11` or newer;
- JDK 17;
- Android Studio;
- Android SDK Platform 36;
- Android SDK Build-Tools `36.0.0`;
- Android NDK `27.1.12297006`;
- Android SDK Platform-Tools, which provides `adb`.

At the time this guide was written, this Mac reported Node `22.22.3`, but Java `11.0.26` and no
`adb` on `PATH`. JDK 17 and Android Platform-Tools therefore need to be installed or selected before
the manual run.

On macOS, the usual session configuration is:

```sh
export JAVA_HOME=$(/usr/libexec/java_home -v 17)
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
```

Now check the tools:

```sh
node --version
java -version
adb version
```

Expected:

- Node is at least `v22.11.0`;
- Java begins with version `17`;
- `adb version` succeeds.

Do not continue until all three checks pass.

## Step 2: prepare the physical device

1. Use a physical Android phone or tablet running Android 7/API 24 or newer. A normal stock device
   is sufficient; root, instrumentation, and special security tooling are not required.
2. On the device, open **Settings > About phone** and tap **Build number** seven times to enable
   Developer options. The exact menu name varies by vendor.
3. Open **Developer options** and enable **USB debugging**.
4. Connect the device to the Mac with a data-capable USB cable.
5. Unlock the device and accept its **Allow USB debugging** prompt.
6. Turn on Do Not Disturb before screenshots.

Run this only as an interactive check:

```sh
adb devices
```

Exactly one intended device should have state `device`. Do **not** screenshot or save this command;
the first column is a stable serial. If the state is `unauthorized`, unlock the device and accept the
authorization prompt. Do not proceed with an emulator entry.

## Step 3: create an isolated released-package harness

The repository example normally uses `file:..`, which would test the local checkout rather than a
released package. The following disposable checkout replaces that dependency with the exact npm
release.

Run the entire block in one terminal:

```sh
TEST_ROOT="$HOME/northset-manual-tests/rn-device-risk-signals-16-$(date +%Y%m%d-%H%M%S)"
printf 'TEST_ROOT=%s\n' "$TEST_ROOT"
mkdir -p "$TEST_ROOT"
git init "$TEST_ROOT/repo"
git -C "$TEST_ROOT/repo" remote add origin https://github.com/AfanasievN/react-native-device-risk-signals.git
git -C "$TEST_ROOT/repo" fetch --depth=1 origin 116ec590fb8e4f68683d674282b5b9371b91085f
git -C "$TEST_ROOT/repo" checkout --detach FETCH_HEAD
mkdir -p "$TEST_ROOT/evidence"
cd "$TEST_ROOT/repo/example"
npm install --save-exact react-native-device-risk-signals@0.5.1 --no-audit --no-fund
```

Keep this terminal open. `$TEST_ROOT` is used by later commands.

## Step 4: prove the exact environment without exposing the device serial

From `$TEST_ROOT/repo/example`, run:

```sh
printf 'package_version='
node -p "require('./node_modules/react-native-device-risk-signals/package.json').version"
printf 'react_native_version='
node -p "require('./node_modules/react-native/package.json').version"
printf 'declared_dependency='
node -p "require('./package.json').dependencies['react-native-device-risk-signals']"
printf 'dependency_is_symlink='
node -e "const fs=require('fs'); console.log(fs.lstatSync('node_modules/react-native-device-risk-signals').isSymbolicLink())"
grep '^newArchEnabled=true$' android/gradle.properties
printf 'android_version='
adb shell getprop ro.build.version.release | tr -d '\r'
printf 'android_api_level='
adb shell getprop ro.build.version.sdk | tr -d '\r'
printf 'device_manufacturer='
adb shell getprop ro.product.manufacturer | tr -d '\r'
printf 'device_model='
adb shell getprop ro.product.model | tr -d '\r'
printf 'build_type=Debug\n'
```

Expected fixed values:

```text
package_version=0.5.1
react_native_version=0.86.0
declared_dependency=0.5.1
dependency_is_symlink=false
newArchEnabled=true
```

The Android version/API and coarse manufacturer/model depend on the physical device.

Take **Screenshot 1: `01-environment.png`** now. Use macOS `Shift-Command-4` and capture only the
command output. Crop out the shell prompt, username, full filesystem path, and any other terminal
history. Confirm that no ADB serial is visible.

Also confirm React Native autolinking resolves the installed release:

```sh
npx react-native config | node -e "let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const c=JSON.parse(s);console.log(c.dependencies['react-native-device-risk-signals'].root)})"
```

The path must end in:

```text
example/node_modules/react-native-device-risk-signals
```

It must not point to the repository root.

## Step 5: verify the example before installing it

Still in `$TEST_ROOT/repo/example`, run:

```sh
npm test -- --runInBand --watchman=false
npm run lint
npx tsc --noEmit
```

All commands must exit `0`. Keep the terminal output, but no screenshot is required.

## Step 6: build and install the Debug app on the phone

Open a second terminal and restore the saved test path by copying the exact `TEST_ROOT=...` value
printed or used in Step 3. Environment exports do not carry across terminals, so also repeat them.
Then run:

```sh
export JAVA_HOME=$(/usr/libexec/java_home -v 17)
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
cd "$TEST_ROOT/repo/example"
adb reverse tcp:8081 tcp:8081
npm start -- --reset-cache
```

Leave Metro running.

Open a third terminal, set the same `TEST_ROOT`, repeat the environment exports, and run:

```sh
export JAVA_HOME=$(/usr/libexec/java_home -v 17)
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
cd "$TEST_ROOT/repo/example"
npm run android
```

Because only one authorized device should be connected, React Native should build the Debug APK,
install it on that device, and launch Signal Bench. If Android asks whether to allow installation or
launch, approve it. Do not use an emulator fallback.

The app package is `com.devicerisksignalsexample`. This check should print an installed APK path:

```sh
adb shell pm path com.devicerisksignalsexample
```

## Step 7: capture the safe pre-collection screen

The phone should show:

- **Inspect this device**;
- an **Android** badge;
- **Local inspection** and text explaining that nothing is uploaded;
- **Collect device signals**;
- **No collection yet**.

Take **Screenshot 2: `02-before-collection.png`**. The safest host-side command is:

```sh
adb exec-out screencap -p > "$TEST_ROOT/evidence/02-before-collection.png"
```

Open the image on the Mac and check it for notifications or personal data before retaining it.

## Step 8: run collection 1

1. On the phone, tap **Collect device signals** once.
2. Wait until the button stops showing **Collecting…**.
3. Confirm the app shows **Latest collection** and **Ready**.
4. Record the observed, skipped, and failed counts and the total duration.

Take **Screenshot 3: `03-first-summary.png`** while the summary is visible. Crop everything beneath
the **Raw JSON** heading so no payload values enter the screenshot:

```sh
adb exec-out screencap -p > "$TEST_ROOT/evidence/03-first-summary.png"
```

If the app instead shows the top-level **Collection failed** panel, take the failure screenshot and
stop. Do not mark the test successful.

## Step 9: prove New Architecture from the runtime probe

Carefully scroll the app's Raw JSON panel until only the `runtime` probe is visible. The safe block
should look conceptually like this:

```json
"runtime": {
  "status": "success",
  "data": {
    "isFabric": true,
    "isTurboModule": true,
    "isBridgeless": true,
    "isDebugBuild": true,
    "reactNativeVersion": "0.86.0",
    "platformOs": "android"
  }
}
```

The Hermes version can vary. The strict New Architecture evidence is `status: success`,
`isFabric: true`, and `isTurboModule: true`. Also record the expected `isBridgeless: true`, React
Native `0.86.0`, Android, and Debug values.

Before taking the screenshot, verify that the visible frame contains **only** this low-sensitivity
runtime block. It must not contain `session_id`, `client_id`, another probe, or unrelated raw values.

Take **Screenshot 4: `04-runtime-new-architecture.png`**:

```sh
adb exec-out screencap -p > "$TEST_ROOT/evidence/04-runtime-new-architecture.png"
```

Crop the saved image tightly around the runtime block and review it again before sharing.

## Step 10: record status-only probe outcomes

Read each probe entry on the phone, but copy only its `status`. Do not copy its `data` object. Use
the exact JSON status words `success`, `skipped`, `timeout`, or `error`.

Fill the first-run column below. For a non-success status, record only a sanitized short reason if
one is present. Do not add raw values.

| Probe ID | Run 1 status | Run 2 status | Sanitized note only if needed |
| --- | --- | --- | --- |
| `device_identity` | | | |
| `hardware` | | | |
| `fonts` | | | |
| `os_integrity` | | | |
| `os_integrity_frida_scan` | | | |
| `network` | | | |
| `telephony` | | | |
| `locale` | | | |
| `geolocation` | | | |
| `media_bluetooth_apps` | | | |
| `application` | | | |
| `device_security_posture` | | | |
| `runtime` | | | |
| `os_integrity_fork_test` | | | Expected `skipped` because disabled by default |
| `gpu_benchmark` | | | Expected `skipped` because disabled by default |
| `audio_latency` | | | Expected `skipped` because disabled by default |
| `transaction_safety` | | | Expected `skipped` because disabled by default |
| `runtime_timing` | | | Expected `skipped` because disabled by default |
| `numeric_consistency` | | | Expected `skipped` because disabled by default |

The pinned release returns all 19 outcomes: 13 enabled probes plus six probes that should report
`skipped` because they are disabled by default. Do not enable those six probes for this task. On a
normal run, the summary is therefore expected to be `13` observed, `6` skipped, and `0` failed;
record the actual result even if it differs.

The summary label **failed** combines `timeout` and `error` outcomes. Preserve the exact status in
the table rather than writing only “failed.”

## Step 11: run collection 2

1. Scroll back to the button and tap **Collect again** once.
2. Wait for **Latest collection** and **Ready**.
3. Record the second counts, duration, and each probe's status in the table.
4. If outcomes differ from run 1, do not rerun until they match. Preserve both and note the
   difference accurately.

Take **Screenshot 5: `05-second-summary.png`**. As with the first summary, crop everything beneath
the **Raw JSON** heading:

```sh
adb exec-out screencap -p > "$TEST_ROOT/evidence/05-second-summary.png"
```

Again, keep Raw JSON values out of the screenshot.

## Step 12: perform the privacy review

Before sending the evidence packet to the operator, inspect all five screenshots at full size and
answer yes to each item:

- [ ] No ADB/device serial is visible.
- [ ] No username or personal filesystem path is visible.
- [ ] No notification, account name, email, or message is visible.
- [ ] No session/client ID is visible.
- [ ] No precise location or local/network address is visible.
- [ ] No stable identifier, certificate hash, font digest, or full build fingerprint is visible.
- [ ] The runtime screenshot contains only the runtime block.
- [ ] The outcome table contains statuses, not raw probe data.

Delete and retake any screenshot that fails this review. Blurring is less reliable than retaking or
cropping the screenshot so the sensitive value never appears.

## Step 13: assemble the evidence packet

Send the operator one folder containing only:

```text
01-environment.png
02-before-collection.png
03-first-summary.png
04-runtime-new-architecture.png
05-second-summary.png
probe-outcomes.md
```

The accompanying text should use this template:

```markdown
Package version: 0.5.1
React Native version: 0.86.0
Platform: Android physical device
OS and coarse device: Android <version>, <manufacturer/model>
Application build: Debug
Architecture: New Architecture enabled; runtime probe reported isFabric=true, isTurboModule=true, and isBridgeless=true

Run 1: <observed> observed, <skipped> skipped, <failed> failed; <duration> ms
Run 2: <observed> observed, <skipped> skipped, <failed> failed; <duration> ms

Probe outcomes:
- device_identity: <status>
- hardware: <status>
- fonts: <status>
- os_integrity: <status>
- os_integrity_frida_scan: <status>
- network: <status>
- telephony: <status>
- locale: <status>
- geolocation: <status>
- media_bluetooth_apps: <status>
- application: <status>
- device_security_posture: <status>
- runtime: <status>
- os_integrity_fork_test: <status>
- gpu_benchmark: <status>
- audio_latency: <status>
- transaction_safety: <status>
- runtime_timing: <status>
- numeric_consistency: <status>

Sanitized observations: <none, or the smallest sanitized explanation of a non-success outcome>

Privacy attestation:
- This came from a physical device, not an emulator or simulator.
- Credentials, account data, location, addresses, stable identifiers, and unrelated values were removed.
- This report documents compatibility only and does not certify detection effectiveness.
- This community report documents collection on the stated configuration only. It is not maintainer
  reproduction or certification of root, emulator, tampering, or instrumentation detection.
```

Do not post this text, comment on issue #16, push a branch, or open a pull request yet. Those are
public actions and require the exact normal Northset approval. Return the local evidence packet to
the operator first.

## What the later documentation patch must contain

After the evidence is reviewed, the contribution should add a row to
`docs/DEVICE_COMPATIBILITY.md` using the documented validation level:

```markdown
| 0.5.1 | Android | Android <version> | <coarse model> | Debug | Community reported | [#16](https://github.com/AfanasievN/react-native-device-risk-signals/issues/16) |
```

The sanitized status table belongs in the pull-request text, not in the matrix row. A separate issue
comment is unnecessary. Never add the full event payload to the repository.

The final clean contribution checkout must run the repository-required checks:

```sh
npm install
npm run verify
npm pack --dry-run
cd example
npm install
npm test -- --runInBand --watchman=false
npm run lint
npx tsc --noEmit
```

Preserve the exact command results for the receipt. Automated command logs are stronger than
screenshots, so no extra screenshot is required for these checks.

## If something fails

### The device is unauthorized

Unlock the device, disconnect and reconnect USB, accept **Allow USB debugging**, then rerun
`adb devices`. Do not capture the serial in evidence.

### The app cannot find Metro

With Metro still running, rerun:

```sh
adb reverse tcp:8081 tcp:8081
```

Then reload the app.

### The native module is missing or collection fails at the top level

Confirm the dependency is the nonsymlinked npm release and rebuild the native app. If it still
fails, capture only the in-app failure panel. For a local diagnostic log:

```sh
adb logcat -c
```

Reproduce once, then save only the app process log locally. Treat that log as sensitive and do not
send it until it has been reviewed and redacted. Stop rather than changing the package or weakening
New Architecture requirements.

### A probe is skipped, times out, or errors

Do not label the whole run a failure if **Latest collection** still reached **Ready**. Record the
exact status on both runs and only the smallest sanitized reason. An unavailable optional field is
not a probe failure and should not be reported as one.

### The runtime probe reports New Architecture off

If `isFabric` or `isTurboModule` is false, the run does not satisfy issue #16. If
`isBridgeless` is unexpectedly false, treat that as a configuration problem too. Confirm
`newArchEnabled=true`, clean/rebuild the Android app, and repeat. Do not publish the invalid run.

## Completion checklist

- [ ] Exact npm release `0.5.1` installed and confirmed nonsymlinked.
- [ ] React Native `0.86.0` recorded.
- [ ] Physical Android device and coarse OS/model recorded.
- [ ] Debug build recorded.
- [ ] `newArchEnabled=true` and runtime New Architecture evidence captured.
- [ ] Two collections reached **Ready**.
- [ ] All 19 returned probe statuses recorded for both runs, including the six expected skips.
- [ ] Five required screenshots captured and privacy-reviewed.
- [ ] No full event payload retained in the shareable evidence packet.
- [ ] Evidence packet returned locally to the operator; no public action taken.
