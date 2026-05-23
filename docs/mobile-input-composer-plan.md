# Mobile Input Composer Upgrade Plan

Date: 2026-05-24

## Summary

The current Android input path is intentionally minimal:

- Android shows a single-line `ChatComposer`.
- `RelayViewModel.sendPrompt(text)` only accepts plain text.
- `RelayClient.sendPrompt()` sends `session.prompt` with `{ session_id, text }`.
- Relay validates only `session_id`, `text`, and max text length.
- Host Bridge forwards the message to `AppServerCodexAdapter.sendPrompt(sessionId, text)`.
- The adapter maps idle sessions to App Server `turn/start` and active sessions to `turn/steer`.

This is enough for lightweight remote prompting, but it cannot express richer mobile intent. The next milestone should replace "send a string" with "submit a prompt draft", then add action-specific messages for edit, pause, media, reasoning depth, one-shot plan mode, and one-shot goal mode.

## Goals

Support these mobile-originated actions:

- Edit the last sent user message and restart/continue from the revised prompt.
- Pause the current active Codex turn.
- Add image input from Android gallery or camera.
- Choose reasoning depth before sending.
- Enable plan mode once for the next prompt.
- Start a one-shot goal for the next prompt.

Non-goals for the first implementation:

- Do not build a full mobile IDE.
- Do not persist raw images in Relay long-term.
- Do not expose unrestricted shell or Git controls through the new composer.
- Do not make plan/goal settings sticky unless the user explicitly asks later.

## Product Shape

The mobile composer should stay compact by default and expand only when the user asks for controls.

Default state:

- Bottom composer remains the primary surface.
- Multi-line text input replaces the single-line field.
- Left icon opens attachment picker.
- Right primary button sends.
- A small settings/control icon opens the "Run options" sheet.
- A stop button appears only when the selected session is actively running.

Expanded composer:

- Shows selected image thumbnails above the text field.
- Shows removable chips for one-shot options:
  - `Plan`
  - `Goal`
  - `Reasoning: Low/Medium/High`
- Shows "Edit last" as a contextual command when the latest visible `user_prompt` belongs to the current session.

Run options sheet:

- Reasoning depth segmented control:
  - `Auto`
  - `Low`
  - `Medium`
  - `High`
  - optionally `XHigh` if App Server support is confirmed.
- One-shot Plan mode toggle.
- One-shot Goal mode row:
  - Toggle.
  - Goal objective field.
  - Optional goal budget field should be deferred until basic goal mode works.
- Safety note:
  - "Applies to the next message only."

Edit last prompt flow:

1. User taps latest user prompt or composer overflow -> `Edit last`.
2. Composer enters edit mode and preloads the prompt text.
3. Send button changes to `Update`.
4. Android sends an edit/retry command, not a normal prompt.
5. Timeline should display a new user prompt and updated Codex turn rather than mutating old history invisibly.

Pause flow:

1. When selected session is active, composer shows a stop control.
2. Tapping it opens a lightweight confirmation if the turn has approvals or Git actions pending.
3. Android sends a `session.turn.interrupt` request.
4. Timeline receives a `turn_interrupted` or `turn_interrupt_requested` event.
5. Composer returns to normal prompting state.

Image input flow:

- Attachment icon opens:
  - `Choose from photos`
  - `Take photo`
- Android shows thumbnails, filename/size, and a remove button.
- First implementation should cap:
  - max 4 images per prompt;
  - max 10 MB per image before downsampling;
  - JPEG/WebP output after downsampling.
- Relay should not keep image bytes in SQLite. It should route an attachment reference or short-lived upload token.

## Protocol Changes

Keep `session.prompt` backward compatible, but allow structured input:

```json
{
  "session_id": "thread-id",
  "text": "optional legacy text",
  "input": [
    { "type": "text", "text": "new prompt" },
    {
      "type": "image",
      "attachment_id": "att_...",
      "mime_type": "image/jpeg",
      "name": "photo.jpg",
      "width": 1280,
      "height": 960
    }
  ],
  "options": {
    "reasoning_effort": "medium",
    "plan_mode": true,
    "goal": {
      "objective": "Finish the current refactor and verify it."
    }
  },
  "client_request_id": "uuid"
}
```

New protocol message types:

- `session.turn.interrupt`
  - client -> Relay -> owning Host Bridge
  - payload: `{ session_id, client_request_id }`
- `session.prompt.edit`
  - client -> Relay -> owning Host Bridge
  - payload: `{ session_id, base_event_id, base_turn_id?, text, input?, options?, client_request_id }`
- `attachment.prepare`
  - client -> Relay
  - payload: `{ session_id, mime_type, size_bytes, sha256, name }`
- `attachment.prepared`
  - Relay -> client
  - payload: `{ attachment_id, upload_url?, max_size_bytes, expires_at }`
- `attachment.committed`
  - client -> Relay
  - payload: `{ attachment_id, storage_ref, metadata }`

MVP shortcut for image input:

- If server Relay upload plumbing is not ready, Android can send a small base64 data URL directly in `session.prompt.input[]`.
- This is acceptable only behind strict caps and should be replaced by attachment references before broad use.

Relay validation:

- Preserve `maxPromptLength` for text.
- Add attachment count and size metadata checks.
- Add `client_request_id` idempotency for prompt/edit/interrupt so reconnect does not duplicate actions.
- Audit prompt/edit/interrupt metadata, not raw image bytes.

## Host Bridge and App Server Mapping

### Normal Prompt

Current:

- idle thread -> `turn/start`
- active thread -> `turn/steer`

Required change:

- Replace `sendPrompt(sessionId, text)` with `sendPrompt(sessionId, draft)`.
- Build App Server `input` from `draft.input`.
- Preserve legacy text by converting `{ text }` into `[ { type: "text", text } ]`.

Reasoning depth:

- Add an adapter function that maps mobile values to the App Server field after schema confirmation.
- Proposed local model:
  - `auto`
  - `low`
  - `medium`
  - `high`
  - `xhigh`
- If the App Server rejects a field, adapter should fall back to no explicit reasoning setting and emit a timeline warning.

Plan mode:

- Treat as one-shot instruction metadata for the next turn.
- Preferred mapping, if App Server exposes a mode field: pass that native field.
- Fallback mapping: prepend a short developer/user instruction to the turn input:
  - "For this turn only, start in planning mode. Ask before editing or running commands."
- The fallback should be visible in the prompt metadata, not silently hidden.

Goal mode:

- Treat as one-shot task objective, not a persistent thread-wide setting for v1.
- Preferred mapping, if App Server exposes native goal support: use it.
- Fallback mapping: prepend a structured instruction:
  - "For this turn only, pursue this goal: <objective>. Track progress explicitly."
- Do not call the Codex app's persistent goal tooling unless a native API is confirmed and reversible from mobile.

### Edit Last Prompt

The right implementation depends on App Server support:

Preferred:

- Use `thread/fork` from the previous user message or turn boundary, then `turn/start` with revised input.
- The original timeline remains intact.
- Android switches selected session to the forked thread if App Server returns a new thread id.

Alternative:

- Use `thread/rollback` to the selected prior turn, then `turn/start`.
- Only use this if rollback semantics are well understood and safe.

Avoid:

- Do not send edited text as `turn/steer` into an already completed turn.
- Do not mutate Relay timeline events in place.

Required adapter methods:

- `editPrompt(sessionId, { baseEventId, baseTurnId, input, options })`
- `findEditableUserPrompt(sessionId)`
- `forkOrRollbackForEdit(sessionId, baseTurnId)`

### Pause

Use App Server `turn/interrupt`.

Required adapter method:

- `interruptTurn(sessionId, { clientRequestId })`

Behavior:

- If no active turn is known, refresh thread state.
- If still no active turn, return a user-facing "No active turn to pause" timeline event.
- On success, clear `activeTurnsByThread[sessionId]`.

## Android Code Changes

### Data Models

Add:

- `PromptDraft`
  - `text`
  - `attachments`
  - `reasoningEffort`
  - `planModeOnce`
  - `goalOnce`
  - `goalObjective`
  - `editingBaseEventId`
  - `editingBaseTurnId`
  - `clientRequestId`
- `PromptAttachment`
  - `localUri`
  - `attachmentId`
  - `mimeType`
  - `displayName`
  - `sizeBytes`
  - `width`
  - `height`
  - `uploadState`

Extend `RelayUiState`:

- selected session active-turn affordance:
  - derived from session stage or latest `turn_started` without later `turn_completed`.
- composer feedback:
  - uploading attachment
  - edit mode
  - interrupt pending

### RelayClient

Add methods:

- `sendPrompt(sessionId: String, draft: PromptDraft)`
- `editPrompt(sessionId: String, draft: PromptDraft)`
- `interruptTurn(sessionId: String)`
- `prepareAttachment(...)`
- `commitAttachment(...)`

Keep existing `sendPrompt(sessionId, text)` as a wrapper until tests and CLI clients are migrated.

### RelayViewModel

Responsibilities:

- Own composer draft state or expose a dedicated `ComposerViewModel`.
- Generate `client_request_id`.
- Validate local draft:
  - text or at least one image required;
  - goal objective required when goal toggle is on;
  - image count/size caps.
- Coordinate image picker output and upload.
- Clear one-shot Plan/Goal/Reasoning settings after successful send.
- Keep edit draft after failed send.

### MainActivity UI

Replace `ChatComposer` with `RichChatComposer`:

- Multi-line text input.
- Attachment button.
- Thumbnail strip.
- Stop button when active.
- Settings button opens `PromptOptionsSheet`.
- Edit mode banner:
  - "Editing last message"
  - Cancel button.
- Send button label:
  - `Send`
  - `Update`
  - disabled while uploading.

Android permissions:

- Gallery:
  - Use Android Photo Picker when available, no broad storage permission.
- Camera:
  - Use `ActivityResultContracts.TakePicture`.
  - Add camera permission only if needed by the chosen camera path.
  - Store temporary capture URI through `FileProvider`.

## Frontend Design Direction

The UI should feel like a polished mobile AI client, not a dense IDE.

Composer visual hierarchy:

- Bottom surface remains dark, rounded, and minimal.
- Text input grows to around 4-6 lines before scrolling internally.
- Tools are icon-first:
  - attachment icon;
  - sliders/tune icon for options;
  - stop icon during active turn;
  - send arrow.
- Use labels only inside sheets or for temporary state chips.

Sheets:

- `PromptOptionsSheet` should be a bottom sheet, not an always-visible panel.
- Keep controls dense but calm:
  - segmented reasoning control;
  - two toggles for Plan and Goal;
  - goal objective text area shown only when Goal is enabled.

Timeline integration:

- Latest user prompt row gets an overflow or edit affordance.
- Editing should visually reference the old prompt with a compact quoted preview in the composer.
- Paused turns should appear as timeline status, not a toast-only action.

## Implementation Phases

### Phase 1: Protocol and Pause

Why first:

- Pause has a clear App Server primitive: `turn/interrupt`.
- It proves the new action-routing path without image storage complexity.

Tasks:

- Add `SessionTurnInterrupt` message type.
- Relay routes it like `session.prompt`.
- Host Bridge calls `adapter.interruptTurn`.
- App Server adapter maps to `turn/interrupt`.
- Android shows stop button for active sessions.
- Add verification script with a mock adapter and, if safe, an App Server smoke test.

Acceptance:

- Active mobile session exposes a stop control.
- Tapping stop routes to Host Bridge.
- Host Bridge emits a timeline event.
- Duplicate stop requests are idempotent enough not to crash or duplicate user-visible errors.

### Phase 2: Structured Prompt Options

Tasks:

- Introduce `PromptDraft` on Android.
- Extend `session.prompt` with `input`, `options`, and `client_request_id`.
- Relay validates structured payload and preserves legacy `text`.
- Host Bridge accepts draft objects.
- App Server adapter maps text input and option metadata.
- Add run options sheet for reasoning, plan once, and goal once.

Acceptance:

- Text prompts still work.
- Reasoning setting is visible in outgoing payload and adapter logs/timeline metadata.
- Plan once and Goal once clear after send.
- Invalid goal-with-empty-objective is blocked locally.

### Phase 3: Edit Last Message

Tasks:

- Identify editable latest `user_prompt` from timeline.
- Add edit affordance and edit mode composer.
- Add `session.prompt.edit`.
- Relay routes edit command to owning Host Bridge.
- App Server adapter implements fork-first edit flow.
- Android switches to returned session if a new thread is created.

Acceptance:

- User can revise last prompt.
- Original history remains visible or recoverable.
- Updated prompt starts a new Codex turn.
- Failed edit does not destroy the original session.

### Phase 4: Image Input

Tasks:

- Add Android Photo Picker.
- Add camera capture path and `FileProvider`.
- Add local downsampling/compression.
- Add attachment protocol.
- Add Relay short-lived attachment storage or server-side object storage reference.
- Host Bridge resolves attachment references and passes image input to App Server.

Acceptance:

- User can attach at least one gallery image.
- User can capture one photo.
- Image appears as a thumbnail before send.
- Send routes image metadata and bytes/reference to Host Bridge.
- Relay does not persist raw image bytes in SQLite.

## Testing Plan

Node/verifier tests:

- `verify-session-turn-interrupt`
- `verify-structured-prompt-options`
- `verify-edit-prompt-flow`
- `verify-attachment-routing`

Android build:

```powershell
.\gradlew.bat :app:assembleDebug --no-daemon
```

Manual Android tests:

- Send normal text.
- Send text with reasoning depth.
- Send text with Plan once; next prompt returns to normal.
- Send Goal once with objective; empty objective blocks send.
- Pause an active turn.
- Edit latest prompt and verify a new turn starts.
- Attach image from gallery.
- Capture image with camera.
- Reconnect during upload/send does not duplicate the prompt.

Security checks:

- Prompt/edit/interrupt require device token.
- Attachment upload requires device token and scoped attachment id.
- Attachment size and MIME type are enforced.
- Relay audit logs metadata only.
- Host Bridge still owns all Codex execution and repo access.

## Open Questions

- What exact App Server field controls reasoning effort?
- Does App Server accept image input in the same `input` array shape currently used for text?
- Is native Plan mode exposed as a field, or should v1 use explicit one-shot instruction text?
- Is native Goal mode exposed through App Server, or should v1 use one-shot objective instructions?
- For editing, is `thread/fork` stable enough for mobile use, or should `thread/rollback` be preferred?

## Recommended Next Step

Implement Phase 1 first: `session.turn.interrupt` plus Android stop control. It is small, high-value, and validates the non-prompt action path that later edit and attachment flows will reuse.
