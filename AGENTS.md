# AGENTS.md

## Project

Codex Mobile Companion is an Android-first mobile control plane for Codex sessions.

The phone is not a mobile IDE. It is an information and command window for observing Codex work, approving blocked actions, sending lightweight prompts, and finishing Git workflows.

## Architecture

Primary route:

Android App -> Server Relay -> Host Bridge -> Codex App Server / Git / local repo

Relay owns auth, pairing, session routing, timeline cache, device identity, power/wake trust metadata, and audit logs.

Host Bridge owns local execution, Codex adapter, Git execution, Windows power actions, and final host policy checks.

Android owns mobile UI, local secure token storage, notifications, prompt input, approvals, Git review, and PC controls UI.

Relay must not execute shell commands or store source code, OpenAI tokens, GitHub tokens, SSH keys, or raw long-lived execution secrets.

## Security Rules

- Pairing token only mints Android device tokens.
- Host token only bootstraps Host Bridge trust.
- Android device token is not enough for high-risk PC controls.
- Power controls require per-device/per-host trust.
- Power verification challenge must live only in Host Bridge memory.
- Host Bridge policy is the final gate for Git write and PC power actions.
- Dangerous features must default off.

## Development Rules

- Update `docs/progress.md` after each construction step.
- Prefer focused verification scripts under `tools/verify-*.mjs`.
- Keep protocol changes in `packages/protocol/index.mjs`.
- Keep Relay persistence in `relay/service/sqlite-store.mjs`.
- Keep Android UI state in `RelayModels.kt` and `RelayViewModel.kt`.
- Do not turn the Android app into an IDE.
- Once you finished a session, never forget to update progress.md ,readme.md and so on
- Once you update the APK,if the android device is connected, you should push the APK to the       device.
- When the code should be commit ,commit it .