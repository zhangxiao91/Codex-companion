# Android Toolchain Setup

本项目的 Android shell 已经有 Gradle/Kotlin/Compose 骨架，但当前机器还缺少 Android 构建工具链。

## Required Versions

- JDK: 17
- Android Gradle Plugin: 9.2.0
- Gradle: 9.4.1
- Android SDK Platform: 36
- Android SDK Build Tools: 36.0.0
- Android SDK Platform Tools: latest installed by Android Studio
- Kotlin Gradle plugin: 2.2.21
- Compose BOM: 2026.04.01

版本依据：

- Android Gradle Plugin 版本和兼容性来自 Android Developers 官方 Gradle Plugin release notes: <https://developer.android.com/build/releases/gradle-plugin>
- Compose BOM 使用 AndroidX 官方 BOM mapping 页面: <https://developer.android.com/develop/ui/compose/bom/bom-mapping>
- Activity Compose 版本来自 AndroidX Activity release notes: <https://developer.android.com/jetpack/androidx/releases/activity>

## Current Machine Check

本轮检测结果：

- `winget` 可用。
- `java` 不可用。
- `gradle` 不可用。
- `adb` 不可用。
- `JAVA_HOME`、`ANDROID_HOME`、`ANDROID_SDK_ROOT` 未设置。
- `winget search` 在当前 shell 中超时，不适合由 Codex 自动安装。

## Recommended Install Path

优先安装 Android Studio，并在安装向导中选择：

- Android SDK Platform 36
- Android SDK Build Tools 36.0.0
- Android SDK Platform Tools
- Android Emulator

然后安装 JDK 17。可选命令：

```powershell
winget install --id Microsoft.OpenJDK.17 -e
winget install --id Google.AndroidStudio -e
```

安装后设置环境变量：

```powershell
$env:JAVA_HOME = "C:\Program Files\Microsoft\jdk-17.0.17.10-hotspot"
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:ANDROID_SDK_ROOT = "$env:LOCALAPPDATA\Android\Sdk"
$env:Path = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:Path"
```

长期环境变量建议在 Windows “Environment Variables” UI 中设置。

## Verification

先运行仓库自检：

```powershell
npm run check:android-toolchain
```

工具链就绪后，在 `android/` 目录构建：

```powershell
cd android
gradle :app:assembleDebug
```

如果使用 Android Studio，直接打开 `android/` 目录，等待 Gradle sync 完成后运行 `app`。

## Current Android Scope

当前 Android shell 只实现静态信息流壳：

- host summary
- session summary
- timeline list
- prompt composer

下一步在工具链可用后接入 Relay WebSocket，并把静态状态替换为真实 `session.snapshot` / `timeline.event`。
