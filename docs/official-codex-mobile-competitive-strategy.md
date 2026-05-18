# Official Codex Mobile Support and Third-Party Differentiation

Last researched: 2026-05-17

This document summarizes public information about OpenAI's official Codex mobile and remote-access support, then identifies where Codex Mobile Companion can still build useful third-party advantages.

## Source Summary

Primary official sources:

- OpenAI product announcement: [Work with Codex from anywhere](https://openai.com/index/work-with-codex-from-anywhere/), published 2026-05-14.
- ChatGPT release notes: [Codex remote access from the ChatGPT mobile app](https://help.openai.com/en/articles/6825453-chatgpt-release-notes), 2026-05-14.
- Codex docs: [Remote connections](https://developers.openai.com/codex/remote-connections).
- Enterprise release notes: [Codex remote access and access tokens for automation](https://help.openai.com/en/articles/10128477-chatgpt-enterprise-edu-release-notes), 2026-05-14.
- Codex docs: [Access tokens](https://developers.openai.com/codex/enterprise/access-tokens).
- Codex docs: [Codex app on Windows](https://developers.openai.com/codex/app/windows).

Public secondary coverage:

- Axios: [OpenAI brings Codex to your phone](https://www.axios.com/2026/05/14/openai-brings-codex-to-your-phone).
- TechCrunch: [OpenAI says Codex is coming to your phone](https://techcrunch.com/2026/05/14/openai-says-codex-is-coming-to-your-phone/).

## What Official Codex Mobile Now Offers

OpenAI has launched Codex remote access inside the ChatGPT mobile app in preview. The public announcement says the mobile experience is for staying connected while Codex works across laptops, devboxes, or remote environments. The ChatGPT release notes state that users can start or continue threads, answer questions, change direction, approve actions, review findings, and move across connected hosts from mobile.

The official remote connections docs describe the mobile flow as a ChatGPT mobile app controlling a Codex App host. The mobile app can:

- start new threads or continue existing ones;
- send follow-up instructions and steer active work;
- approve commands and actions;
- review outputs, diffs, test results, terminal output, and screenshots;
- receive task-completion or attention-needed notifications;
- switch between connected hosts and threads.

OpenAI's architecture keeps execution on the connected host. Repository files, shell commands, plugins, MCP servers, skills, browser access, Computer Use, signed-in websites, sandboxing, and approval controls come from that host. The official announcement also says OpenAI uses a secure relay layer so trusted machines can stay reachable without direct public exposure.

The setup flow is currently host-first: open the Codex App on the host, start mobile setup, scan a QR code from the phone, then finish the ChatGPT account/workspace authentication flow. Enterprise users may also need workspace Remote Control enabled plus SSO, MFA, or passkey completion.

Important current availability constraints:

- The feature is preview.
- It is rolling out on iOS and Android across supported regions and plans, including Free and Go.
- Mobile setup currently requires the Codex App for macOS as the host.
- The docs explicitly say the setup flow is not available from the Codex CLI or IDE Extension.
- OpenAI's announcement says Windows phone-to-Codex-App support is coming soon.
- The host must remain awake, online, and running Codex for remote access to continue.

OpenAI has also introduced Codex access tokens for Business and Enterprise workspaces. Those tokens are for trusted, non-interactive local workflows that need ChatGPT workspace identity and governance. They are not general OpenAI API keys, and the docs emphasize secret storage, rotation, trusted runners, and clear ownership.

The official Windows app now exists and supports core desktop workflows such as worktrees, automations, Git functionality, in-app browser, artifact previews, plugins, skills, native PowerShell execution, Windows sandboxing, and WSL2. However, this is distinct from mobile remote setup: the mobile docs still describe macOS as the current required Codex App host.

## Competitive Implication

The official product has moved directly into the same broad category as this project: mobile supervision of long-running Codex work. Competing as "Codex on a phone" is no longer enough.

The useful third-party position should shift from "mobile access exists" to:

> Android-native, self-hostable, host-agnostic operational control for Codex sessions, optimized for Windows, server Relay, Git finishing, and personal/team policy control.

We should assume OpenAI will quickly improve the general ChatGPT mobile experience. Our strongest opportunities are where a third-party tool can be narrower, more configurable, and closer to a user's own infrastructure than the official ChatGPT app should be.

## Where We Can Still Beat Official Codex

### 1. Windows-First Remote Control

Official mobile setup currently requires a macOS Codex App host, while our user base and current test environment are Windows-heavy. The official Windows app exists, but mobile host support is still not the documented path.

Our opportunity:

- Make Windows Host Bridge a first-class path now.
- Support PowerShell, Windows Git, WSL, and mixed Windows/WSL projects explicitly.
- Provide one-command setup that generates a pairing code and starts the bridge.
- Keep documenting Windows-specific policy failures, execution policy, PATH, Git, and app-server issues.

This is the clearest short-term wedge.

### 2. CLI/App-Server/Adapter-First Support

Official mobile setup is documented through the Codex App host, not the CLI or IDE Extension. Our architecture already treats Codex as an adapter behind Host Bridge.

Our opportunity:

- Support Codex App Server, CLI, mock adapter, and later other agent runtimes behind one Relay protocol.
- Avoid requiring the user to keep a specific desktop UI open if a background service can provide the session stream.
- Let server-side Codex appear as a host without needing a physical desktop app.
- Keep the Relay protocol narrow and stable so new runtimes can be added.

This creates a product that is less polished than official ChatGPT, but more operationally flexible.

### 3. Self-Hosted Relay and Data Boundary Control

Official Codex uses OpenAI's secure relay layer and ChatGPT account/workspace identity. That is a strength for most users, but it is not the same as user-owned infrastructure.

Our opportunity:

- Offer a self-hosted Relay that can run on the user's VPS.
- Store only metadata, cursors, device identity, and audit records.
- Keep source code, raw terminal output, tokens, SSH keys, and repo content on host machines.
- Make Relay deployment explicit: HTTPS/WSS reverse proxy, health checks, identity store, audit store, backup, and rotation.
- Let advanced users choose their own domain, firewall, logging retention, and backup policy.

This is a durable niche: some users will prefer an auditable personal control plane even if ChatGPT mobile is more convenient.

### 4. Android-Native Operational UX

Official Codex mobile lives inside the general ChatGPT app. That gives distribution and account continuity, but it also means the UI must coexist with general chat, consumer features, and broad product constraints.

Our opportunity:

- Build an Android-native "agent operations inbox" rather than a chat surface.
- Prioritize active sessions, blocked approvals, failed commands, Git state, and completion notifications.
- Add Android-specific affordances:
  - notification actions for approve/deny/continue;
  - home-screen widgets for active sessions;
  - quick replies and saved prompt snippets;
  - share-sheet entry points for logs, screenshots, links, or issue text;
  - persistent foreground-service diagnostics for connection state.
- Optimize for one-thumb review, not writing large prompts.

This direction matches the original product insight: the phone is an information-flow window, not an IDE.

### 5. Safer Mobile Approval and Policy Controls

Official mobile approvals are powerful, but mobile approval while distracted is inherently risky. Public coverage has already noted that phone approvals can increase error risk.

Our opportunity:

- Add a policy layer before dangerous actions reach the host.
- Classify approvals by risk: read-only, file write, dependency install, shell command, Git commit, Git push.
- Require stronger confirmation for destructive actions:
  - typed confirmation for push;
  - file/path summaries before commit;
  - branch protection checks;
  - host allow/deny policy;
  - "approve once" vs "approve this class for this session".
- Show mobile-optimized diffs and command explanations.
- Keep metadata-only audit events for every action.

The win is not just "can approve from phone"; it is "can approve from phone without losing situational awareness."

### 6. Git Finishing Workflow

Official Codex can review diffs and operate on host context, but our product can be very opinionated about the last mile of coding work.

Our opportunity:

- Make Git status/diff/commit/push a first-class mobile workflow.
- Support tracked/untracked handling, commit strategy, push confirmation, and host policy checks.
- Add "ready to review" summaries:
  - changed files;
  - tests run;
  - risks;
  - branch and remote;
  - PR link when available.
- Later add GitHub/GitLab issue and PR actions without becoming a full mobile Git client.

This is a concrete differentiator because it turns mobile supervision into a completion workflow.

### 7. Multi-Host, Multi-Runtime Control Plane

Official Codex can switch between connected hosts and can use SSH hosts through the Codex App. A third-party Relay can go further by treating hosts as a fleet.

Our opportunity:

- Represent local PC, VPS, devbox, CI runner, and future cloud Codex nodes uniformly.
- Let one Android app route to multiple hosts without caring which runtime backs each host.
- Add host health, heartbeat, last error, adapter type, repo list, and capability tags.
- Support "server Codex host" as a peer of the local PC host.
- Eventually support non-Codex coding agents if useful, while keeping Codex as the primary path.

The product becomes an agent operations panel rather than a Codex-only remote UI clone.

### 8. Local-First Diagnostics and Repair

Official troubleshooting is necessarily general. Our tool can be aggressively diagnostic because it owns the Relay/Bridge protocol.

Our opportunity:

- Ship test-connection flows for Android, Relay, Host Bridge, app-server, Git, and push permissions.
- Show exact failure category:
  - Relay unreachable;
  - auth failed;
  - host offline;
  - stale session;
  - app-server disconnected;
  - policy blocked;
  - Git working tree unsafe;
  - push requires confirmation.
- Generate repair commands for Windows, PowerShell, Node, firewall, and server reverse proxy.
- Keep smoke-test scripts as product assets, not just developer tests.

This is unglamorous but valuable. Remote agent systems fail at the edges; clear diagnostics can beat a polished UI.

## Where We Should Not Compete Head-On

Avoid spending energy on:

- becoming a general ChatGPT replacement;
- matching official model picker and account entitlement UX;
- replicating all Codex desktop UI features;
- building a phone IDE;
- competing on broad iOS/Android coverage before Android is excellent;
- storing full logs, repo files, or terminal streams in Relay by default;
- trying to outdo OpenAI's own secure relay for mainstream users.

The official app will likely win on account integration, rollout reach, model access, and generic polish. Our advantage must come from narrower control, host flexibility, and self-hosted operations.

## Recommended Product Strategy

### Short Term: 2-4 Weeks

Focus on the wedge official docs currently leave open:

1. Make Windows + Android + server Relay the flagship path.
2. Stabilize pairing, reconnect, stale-session cleanup, and host health diagnostics.
3. Make Git status/diff/commit/push review feel substantially better on Android.
4. Add explicit mobile approval risk labels.
5. Keep server smoke tests and manual Android tests up to date.

Success metric:

- From mobile data, the user can see a Windows Codex session, understand what it is doing, approve safely, and finish with a Git action.

### Medium Term: 1-2 Months

Build durable infrastructure advantage:

1. Replace the shared dev token with short-lived pairing codes, per-device tokens, and per-host tokens.
2. Add device revocation and host token rotation.
3. Add durable timeline cursor state and metadata audit.
4. Add Android notification actions.
5. Add a server-host Codex mode so the VPS can run Codex directly.
6. Add clearer adapter boundaries for Codex App Server, CLI, and future runtimes.

Success metric:

- Relay can survive restarts, hosts can reconnect cleanly, and a user can operate two hosts from Android with low ambiguity.

### Longer Term

Only after the core loop is reliable:

1. Add model/runtime abstraction only if it solves a real user need.
2. Add team features if more than one user actively needs them.
3. Add PR provider integrations after the Git mobile workflow is strong.
4. Consider a companion web dashboard for server administration, not as a replacement for Android.

## Roadmap Adjustment

The official launch reduces the value of a generic "mobile Codex viewer." It increases the value of:

- Windows-first host support;
- self-hosted Relay;
- Android-native operations UX;
- Git finishing;
- security policy and audit;
- diagnostics and repair flows;
- server-hosted Codex support.

The next implementation milestone should therefore remain server-first, but the UI priority should shift from broad session display to "operational clarity": host state, blocked work, approval risk, Git readiness, and reliable reconnect behavior.

## Open Questions

- Will OpenAI's Windows mobile host support close the Windows-first gap quickly?
- Will the official Codex App expose public hooks or APIs for third-party mobile clients?
- Can we use official Codex access tokens safely in Host Bridge for server-side Codex workflows?
- How much terminal output should Android show before it becomes noisy or risky?
- Should this project remain Codex-only, or become an agent-control plane that can host Codex plus other runtimes?

## Current Conclusion

Official Codex mobile support validates the category. It also raises the bar.

Codex Mobile Companion should not try to be a smaller ChatGPT mobile. It should become the practical Android-native control plane for users who want their own Relay, their own host policies, strong Windows/server support, and a faster path from "Codex is working" to "the work is safely reviewed, committed, and pushed."
