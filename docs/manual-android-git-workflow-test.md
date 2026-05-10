# Manual Android Git Workflow Test

This checklist validates the Android Git workflow against a disposable repository and remote. Do not use a real repository for this test.

## Goal

- Pair Android with Relay.
- Show Git status and file diff in Android.
- Send a guarded commit request.
- Send a guarded push request.
- Verify Git audit entries in Android.

## Prepare Disposable Repos

Run from any scratch directory:

```powershell
$root = Join-Path $env:TEMP "cmc-android-git-manual"
Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $root | Out-Null

git init --bare (Join-Path $root "remote.git")
git init -b main (Join-Path $root "work")
Set-Location (Join-Path $root "work")
git config user.email "codex-mobile@example.invalid"
git config user.name "Codex Mobile Manual Test"
"# Codex Mobile manual Git test" | Set-Content README.md
git add README.md
git commit -m "Initial manual test commit"
git remote add origin (Join-Path $root "remote.git")
git push -u origin main

"Manual Android diff" | Add-Content README.md
```

Keep the final `work` path. It will be used as `MOCK_SESSION_REPO_PATH`.

## Start Relay

In the project repository:

```powershell
$env:RELAY_HOST='0.0.0.0'
$env:RELAY_PORT='8787'
$env:RELAY_DEV_TOKEN='choose-a-random-dev-token'
$env:RELAY_GIT_AUDIT_LOG_PATH=(Join-Path $env:TEMP "cmc-android-git-audit.ndjson")
npm run relay
```

If Windows Firewall prompts, allow private network access.

## Start Host Bridge

In a second terminal:

```powershell
$env:RELAY_URL='ws://127.0.0.1:8787'
$env:RELAY_DEV_TOKEN='choose-a-random-dev-token'
$env:MOCK_SESSION_REPO_PATH='<absolute path to disposable work repo>'
$env:GIT_WRITE_ACTIONS_ENABLED='true'
$env:GIT_PUSH_ACTIONS_ENABLED='true'
npm run bridge
```

Use the exact disposable `work` path created earlier.

## Android Steps

1. Install or open the Android app.
2. Set Relay URL:
   - Emulator: `ws://10.0.2.2:8787`
   - Physical device: `ws://<computer LAN IP>:8787`
3. Set Pairing token to the Relay token.
4. Tap Save.
5. Tap Pair and confirm the paired-device message.
6. Tap Test and confirm `health ok`.
7. Tap Connect/Refresh if needed.
8. Select the mock session.
9. Tap Status.
10. Confirm README.md appears as a changed file.
11. Tap README.md and confirm the diff preview shows `Manual Android diff`.
12. Enter commit message: `Manual Android Git test`.
13. Tap Commit, then Confirm.
14. Tap Status and confirm the worktree is clean.
15. Tap Push, then Push in the confirmation dialog.
16. Tap Refresh in Git audit and confirm recent commit/push audit rows appear.

## Expected Computer Logs

Relay should show:

```text
[relay] routing git status to host ...
[relay] routing git diff to host ...
[relay] routing git commit to host ...
[relay] routing git push to host ...
[relay] git snapshot: mock-session-001 push
```

Bridge should show:

```text
[bridge] received git status for mock-session-001
[bridge] received git diff for mock-session-001
[bridge] received git commit for mock-session-001
[bridge] received git push for mock-session-001
```

## Verify Remote

From the disposable work repo:

```powershell
git status --short
git log --oneline --decorate -3
git --git-dir="<absolute path to disposable remote.git>" log --oneline --decorate -3
```

Expected:

- `git status --short` is empty.
- Local and bare remote logs include `Manual Android Git test`.
- Android Git audit includes completed commit and push entries.

## Safety Notes

- Keep `GIT_WRITE_ACTIONS_ENABLED` and `GIT_PUSH_ACTIONS_ENABLED` unset for normal development unless testing a disposable repo.
- Do not point `MOCK_SESSION_REPO_PATH` at a real project while push gates are enabled.
- This remains a development-mode flow using temporary dev tokens, not a public-network setup.
