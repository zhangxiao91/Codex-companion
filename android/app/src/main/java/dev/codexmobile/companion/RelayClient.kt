package dev.codexmobile.companion

import java.util.UUID
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import org.json.JSONArray
import java.util.Timer
import java.util.TimerTask
import java.util.concurrent.TimeUnit

class RelayClient(
    private val listener: Listener,
    private val client: OkHttpClient = defaultHttpClient()
) {
    interface Listener {
        fun onConnected()
        fun onDisconnected(reason: String)
        fun onHostSnapshot(host: HostNode)
        fun onSessionSnapshot(session: CodexSession, clientRequestId: String?)
        fun onApprovalRequest(approval: ApprovalItem)
        fun onGitSnapshot(snapshot: GitSnapshot)
        fun onGitAudit(sessionId: String, events: List<GitAuditItem>)
        fun onPowerStatus(status: PowerStatus)
        fun onPowerTrustChallenge(challenge: PowerTrustChallenge)
        fun onPowerTrustGranted(trust: PowerTrust)
        fun onPowerResult(result: PowerResult)
        fun onTimelineEvent(event: TimelineItem)
        fun onTimelinePage(sessionId: String, events: List<TimelineItem>, hasMoreBefore: Boolean, source: String)
        fun onSessionSyncIndex(
            entries: List<SessionSyncEntry>,
            unchangedCount: Int,
            hasMore: Boolean,
            nextCursor: String?
        )
        fun onNotificationEvent(notification: NotificationEvent)
        fun onRelayRequestState(state: RelayRequestState)
        fun onHealthCheck(summary: String)
        fun onHealthDiagnostics(diagnostics: ConnectionDiagnostics)
        fun onPairingComplete(deviceId: String, deviceToken: String)
        fun onError(message: String)
    }

    @Volatile
    private var socket: WebSocket? = null
    private var authToken: String = ""
    private val pendingAcks = mutableMapOf<String, PendingAck>()
    private val ackTimer = Timer("relay-client-ack-timer", true)

    fun connect(
        url: String = DEFAULT_RELAY_URL,
        token: String = "",
        preservePendingAcks: Boolean = false
    ) {
        close(clearPendingAcks = !preservePendingAcks)
        authToken = token.trim()
        val request = Request.Builder().url(url).build()
        val nextSocket = client.newWebSocket(
            request,
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    if (!isCurrentSocket(webSocket)) {
                        webSocket.close(1000, "stale connection")
                        return
                    }
                    socket = webSocket
                    subscribeAll()
                    listener.onConnected()
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    if (!isCurrentSocket(webSocket)) {
                        return
                    }
                    handleMessage(text)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    if (!isCurrentSocket(webSocket)) {
                        return
                    }
                    socket = null
                    listener.onDisconnected(reason.ifBlank { "Closed" })
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    if (!isCurrentSocket(webSocket)) {
                        return
                    }
                    socket = null
                    listener.onDisconnected(t.message ?: "WebSocket failed")
                }
            }
        )
        socket = nextSocket
    }

    fun close(clearPendingAcks: Boolean = true) {
        socket?.close(1000, "closing")
        socket = null
        if (clearPendingAcks) {
            clearPendingAcks("Relay disconnected before request was acknowledged.")
        }
    }

    private fun isCurrentSocket(webSocket: WebSocket): Boolean = socket === webSocket

    fun subscribeAll(): Boolean {
        return send("session.subscribe", JSONObject().put("session_id", "*"))
    }

    fun requestTimeline(
        sessionId: String,
        afterCursor: String? = null,
        beforeCursor: String? = null,
        limit: Int = 300,
        cacheOnly: Boolean = false,
        page: Boolean = false
    ): Boolean {
        val payload = JSONObject()
            .put("session_id", sessionId)
            .put("limit", limit.coerceIn(1, 300))
        if (!afterCursor.isNullOrBlank()) {
            payload.put("after_cursor", afterCursor)
        }
        if (!beforeCursor.isNullOrBlank()) {
            payload.put("before_cursor", beforeCursor)
        }
        if (cacheOnly) {
            payload.put("cache_only", true)
        }
        if (page) {
            payload.put("page", true)
        }
        return send("session.timeline.request", payload)
    }

    fun requestSessionSyncIndex(
        selectedSessionId: String? = null,
        limit: Int = 200,
        includeArchived: Boolean = false,
        includeClean: Boolean = false,
        sessionIds: List<String> = emptyList()
    ): Boolean {
        val payload = JSONObject()
            .put("limit", limit.coerceIn(1, 500))
            .put("include_archived", includeArchived)
            .put("include_clean", includeClean)
        if (!selectedSessionId.isNullOrBlank()) {
            payload.put("selected_session_id", selectedSessionId)
        }
        if (sessionIds.isNotEmpty()) {
            payload.put("session_ids", JSONArray(sessionIds.distinct().take(100)))
        }
        return send("session.sync.index", payload)
    }

    fun ackSessionSync(entries: Collection<SessionSyncEntry>): Boolean {
        if (entries.isEmpty()) {
            return true
        }
        val sessions = JSONArray()
        entries.forEach { entry ->
            sessions.put(
                JSONObject()
                    .put("session_id", entry.session.sessionId)
                    .put("seen_snapshot_revision", entry.snapshotRevision)
                    .put("seen_stage_revision", entry.stageRevision)
                    .put("seen_timeline_cursor", entry.timelineNewestCursor)
                    .put("seen_sync_revision", entry.syncRevision)
            )
        }
        return send("session.sync.ack", JSONObject().put("sessions", sessions))
    }

    fun updateSessionArchive(sessionId: String, archived: Boolean): Boolean =
        send(
            "session.archive.update",
            JSONObject()
                .put("session_id", sessionId)
                .put("archived", archived)
        )

    fun updateSessionPin(sessionId: String, pinned: Boolean): Boolean =
        send(
            "session.pin.update",
            JSONObject()
                .put("session_id", sessionId)
                .put("pinned", pinned)
        )

    fun sendPrompt(sessionId: String, text: String): Boolean {
        return sendPrompt(
            sessionId,
            PromptDraft(text = text)
        )
    }

    fun sendPrompt(sessionId: String, draft: PromptDraft): Boolean {
        return send(
            "session.prompt",
            promptDraftPayload(sessionId, draft)
        )
    }

    fun editPrompt(sessionId: String, draft: PromptDraft): Boolean {
        return send(
            "session.prompt.edit",
            promptDraftPayload(sessionId, draft)
                .put("base_event_id", draft.editingBaseEventId.orEmpty())
                .put("base_turn_id", draft.editingBaseTurnId ?: JSONObject.NULL)
        )
    }

    fun queuePrompt(sessionId: String, text: String): Boolean {
        return send(
            "session.prompt.queue",
            JSONObject()
                .put("session_id", sessionId)
                .put("text", text)
                .put("client_request_id", java.util.UUID.randomUUID().toString())
        )
    }

    fun interruptTurn(sessionId: String): Boolean {
        return send(
            "session.turn.interrupt",
            JSONObject()
                .put("session_id", sessionId)
                .put("client_request_id", java.util.UUID.randomUUID().toString())
        )
    }

    fun createNewChat(hostId: String, clientRequestId: String = java.util.UUID.randomUUID().toString()): Boolean {
        return send(
            "session.create",
            JSONObject()
                .put("host_id", hostId)
                .put("ephemeral", false)
                .put("persist_extended_history", true)
                .put("service_name", "codex-mobile-companion")
                .put("client_request_id", clientRequestId)
        )
    }

    fun requestGit(
        sessionId: String,
        action: String,
        filePath: String? = null,
        message: String? = null,
        commitStrategy: String? = null
    ): Boolean {
        val payload = JSONObject()
            .put("session_id", sessionId)
            .put("action", action)
        if (!filePath.isNullOrBlank()) {
            payload.put("file_path", filePath)
        }
        if (!message.isNullOrBlank()) {
            payload.put("message", message)
        }
        if (!commitStrategy.isNullOrBlank()) {
            payload.put("commit_strategy", commitStrategy)
        }
        return send("git.request", payload)
    }

    fun requestPowerTrust(hostId: String): Boolean {
        return send(
            "power.trust.request",
            JSONObject().put("host_id", hostId)
        )
    }

    fun verifyPowerTrust(hostId: String, challengeId: String, code: String): Boolean {
        return send(
            "power.trust.verify",
            JSONObject()
                .put("host_id", hostId)
                .put("challenge_id", challengeId)
                .put("code", code)
        )
    }

    fun requestPower(hostId: String, action: String, durationSeconds: Int? = null): Boolean {
        val payload = JSONObject()
            .put("host_id", hostId)
            .put("action", action)
        if (durationSeconds != null) {
            payload.put("duration_seconds", durationSeconds)
        }
        return send("power.request", payload)
    }

    fun sendApprovalDecision(approvalId: String, decision: String): Boolean {
        return send(
            "approval.decision",
            JSONObject()
                .put("approval_id", approvalId)
                .put("decision", decision)
        )
    }

    fun testHealth(url: String = DEFAULT_RELAY_URL, token: String = "") {
        runCatching {
            val healthUrl = healthUrlFor(url)
            val requestBuilder = Request.Builder().url(healthUrl)
            val trimmedToken = token.trim()
            addAuthHeaders(requestBuilder, trimmedToken)
            addShortHttpHeaders(requestBuilder)
            val request = requestBuilder.build()
            client.newCall(request).enqueue(
                object : okhttp3.Callback {
                    override fun onFailure(call: okhttp3.Call, e: java.io.IOException) {
                        listener.onError("Health check failed: ${e.message}")
                    }

                    override fun onResponse(call: okhttp3.Call, response: Response) {
                        response.use {
                            val body = it.body.string()
                            if (!it.isSuccessful) {
                                listener.onError("Health check failed: HTTP ${it.code}")
                                return
                            }

                            listener.onHealthDiagnostics(parseHealthDiagnostics(body, healthUrl))
                            listener.onHealthCheck(summarizeHealth(body))
                        }
                    }
                }
            )
        }.onFailure { error ->
            listener.onError(error.message ?: "Invalid Relay URL")
        }
    }

    fun requestGitAudit(url: String = DEFAULT_RELAY_URL, token: String = "", sessionId: String, limit: Int = 20) {
        runCatching {
            val requestBuilder = Request.Builder().url(gitAuditUrlFor(url, sessionId, limit))
            addAuthHeaders(requestBuilder, token.trim())
            addShortHttpHeaders(requestBuilder)
            val request = requestBuilder.build()
            client.newCall(request).enqueue(
                object : okhttp3.Callback {
                    override fun onFailure(call: okhttp3.Call, e: java.io.IOException) {
                        listener.onError("Git audit failed: ${e.message}")
                    }

                    override fun onResponse(call: okhttp3.Call, response: Response) {
                        response.use {
                            val raw = it.body.string()
                            if (!it.isSuccessful) {
                                listener.onError("Git audit failed: HTTP ${it.code}")
                                return
                            }

                            val json = JSONObject(raw)
                            if (!json.optBoolean("ok", false)) {
                                listener.onError(json.optString("detail", "Git audit failed"))
                                return
                            }

                            val eventsJson = json.optJSONArray("events")
                            val events = if (eventsJson == null) {
                                emptyList()
                            } else {
                                List(eventsJson.length()) { index ->
                                    parseGitAuditItem(eventsJson.getJSONObject(index))
                                }
                            }
                            listener.onGitAudit(sessionId, events)
                        }
                    }
                }
            )
        }.onFailure { error ->
            listener.onError(error.message ?: "Invalid Relay URL")
        }
    }

    fun pairDevice(url: String = DEFAULT_RELAY_URL, pairingToken: String = "", existingDeviceId: String = "") {
        runCatching {
            val token = pairingToken.trim()
            if (token.isBlank()) {
                listener.onError("Pairing token is required")
                return
            }

            val body = JSONObject()
                .put("device_id", existingDeviceId.ifBlank { UUID.randomUUID().toString() })
                .put("display_name", "Android device")
                .toString()
                .toRequestBody(JSON_MEDIA_TYPE)
            val request = Request.Builder()
                .url(pairUrlFor(url))
                .header("X-Relay-Pairing-Token", token)
                .header("X-Relay-Dev-Token", token)
                .header("Connection", "close")
                .header("Accept", "application/json")
                .post(body)
                .build()

            client.newCall(request).enqueue(
                object : okhttp3.Callback {
                    override fun onFailure(call: okhttp3.Call, e: java.io.IOException) {
                        listener.onError("Pairing failed: ${e.message}")
                    }

                    override fun onResponse(call: okhttp3.Call, response: Response) {
                        response.use {
                            val raw = it.body.string()
                            if (!it.isSuccessful) {
                                listener.onError("Pairing failed: HTTP ${it.code}${errorDetail(raw)}")
                                return
                            }

                            val json = JSONObject(raw)
                            if (!json.optBoolean("ok", false)) {
                                listener.onError(json.optString("detail", "Pairing failed"))
                                return
                            }

                            listener.onPairingComplete(
                                json.getString("device_id"),
                                json.getString("device_token")
                            )
                        }
                    }
                }
            )
        }.onFailure { error ->
            listener.onError(error.message ?: "Invalid Relay URL")
        }
    }

    private fun handleMessage(raw: String) {
        runCatching {
            val message = JSONObject(raw)
            when (val type = message.getString("type")) {
                "host.snapshot" -> listener.onHostSnapshot(
                    parseHostSnapshot(message.getJSONObject("payload"))
                )

                "session.snapshot" -> {
                    val payload = message.getJSONObject("payload")
                    listener.onSessionSnapshot(
                        parseSession(payload.getJSONObject("session")),
                        payload.optString("client_request_id", "").takeIf { it.isNotBlank() }
                    )
                }

                "approval.request" -> listener.onApprovalRequest(
                    parseApproval(message.getJSONObject("payload").getJSONObject("approval"))
                )

                "git.snapshot" -> listener.onGitSnapshot(
                    parseGitSnapshot(message.getJSONObject("payload").getJSONObject("snapshot"))
                )

                "power.status" -> listener.onPowerStatus(
                    parsePowerStatus(message.getJSONObject("payload"))
                )

                "power.trust.challenge" -> listener.onPowerTrustChallenge(
                    parsePowerTrustChallenge(message.getJSONObject("payload"))
                )

                "power.trust.granted" -> listener.onPowerTrustGranted(
                    parsePowerTrust(message.getJSONObject("payload").optJSONObject("trust") ?: message.getJSONObject("payload"))
                )

                "power.result" -> listener.onPowerResult(
                    parsePowerResult(message.getJSONObject("payload"))
                )

                "timeline.event" -> listener.onTimelineEvent(
                    parseTimelineEvent(message.getJSONObject("payload").getJSONObject("event"))
                )

                "timeline.page" -> {
                    val payload = message.getJSONObject("payload")
                    val eventsArray = payload.optJSONArray("events")
                    val events = if (eventsArray == null) {
                        emptyList()
                    } else {
                        List(eventsArray.length()) { index -> parseTimelineEvent(eventsArray.getJSONObject(index)) }
                    }
                    listener.onTimelinePage(
                        sessionId = payload.optString("session_id", ""),
                        events = events,
                        hasMoreBefore = payload.optBoolean("has_more_before", false),
                        source = payload.optString("source", "")
                    )
                }

                "session.sync.index.result" -> {
                    val payload = message.getJSONObject("payload")
                    val entriesArray = payload.optJSONArray("sessions")
                    val entries = if (entriesArray == null) {
                        emptyList()
                    } else {
                        List(entriesArray.length()) { index -> parseSessionSyncEntry(entriesArray.getJSONObject(index)) }
                    }
                    listener.onSessionSyncIndex(
                        entries = entries,
                        unchangedCount = payload.optInt("unchanged_count", 0),
                        hasMore = payload.optBoolean("has_more", false),
                        nextCursor = payload.optString("next_cursor", "").takeIf { it.isNotBlank() }
                    )
                }

                "notification.event" -> listener.onNotificationEvent(
                    parseNotificationEvent(message.getJSONObject("payload").getJSONObject("notification"))
                )

                "message.ack" -> handleAck(message.getJSONObject("payload"))

                "error" -> listener.onError(
                    message.getJSONObject("payload").optString("detail", "Relay error")
                )

                else -> listener.onError("Unsupported relay message: $type")
            }
        }.onFailure { error ->
            listener.onError(error.message ?: "Failed to parse relay message")
        }
    }

    private fun send(type: String, payload: JSONObject): Boolean {
        val currentSocket = socket
        if (currentSocket == null) {
            listener.onError("Relay is not connected. Reconnect before sending ${type}.")
            return false
        }

        val messageId = UUID.randomUUID().toString()
        val message = JSONObject()
            .put("id", messageId)
            .put("type", type)
            .put("sent_at", java.time.Instant.now().toString())
            .put("payload", payload)
        if (authToken.isNotBlank()) {
            message.put("auth", JSONObject().put("token", authToken))
        }
        val accepted = currentSocket.send(message.toString())
        if (!accepted) {
            listener.onError("Relay send failed for ${type}. Reconnect and try again.")
            return false
        }
        trackAckIfNeeded(messageId, type, message)
        return true
    }

    private fun trackAckIfNeeded(messageId: String, type: String, message: JSONObject) {
        if (type !in ACK_REQUIRED_TYPES) {
            return
        }

        synchronized(pendingAcks) {
            pendingAcks[messageId] = PendingAck(messageId, type, message.toString(), attempts = 1, disconnectedPolls = 0)
        }
        listener.onRelayRequestState(
            RelayRequestState(
                type = type,
                label = requestLabel(type),
                phase = "waiting_ack",
                messageId = messageId,
                attempts = 1,
                updatedAt = java.time.Instant.now().toString()
            )
        )
        scheduleAckTimeout(messageId)
    }

    private fun scheduleAckTimeout(messageId: String) {
        ackTimer.schedule(
            object : TimerTask() {
                override fun run() {
                    handleAckTimeout(messageId)
                }
            },
            ACK_TIMEOUT_MS
        )
    }

    private fun handleAckTimeout(messageId: String) {
        val retry = synchronized(pendingAcks) {
            val pending = pendingAcks[messageId] ?: return
            if (socket == null) {
                if (pending.disconnectedPolls >= ACK_MAX_DISCONNECTED_POLLS) {
                    pendingAcks.remove(messageId)
                    listener.onRelayRequestState(
                        RelayRequestState(
                            type = pending.type,
                            label = requestLabel(pending.type),
                            phase = "interrupted",
                            messageId = pending.messageId,
                            attempts = pending.attempts,
                            updatedAt = java.time.Instant.now().toString()
                        )
                    )
                    listener.onError("Relay disconnected before ${requestLabel(pending.type).lowercase()} was confirmed.")
                    return
                }
                pendingAcks[messageId] = pending.copy(disconnectedPolls = pending.disconnectedPolls + 1)
                scheduleAckTimeout(messageId)
                return
            }
            if (pending.attempts > ACK_MAX_RETRIES) {
                pendingAcks.remove(messageId)
                listener.onRelayRequestState(
                    RelayRequestState(
                        type = pending.type,
                        label = requestLabel(pending.type),
                        phase = "failed",
                        messageId = pending.messageId,
                        attempts = pending.attempts,
                        updatedAt = java.time.Instant.now().toString()
                    )
                )
                listener.onError("Relay did not acknowledge ${pending.type}. Check connection and retry.")
                return
            }
            val next = pending.copy(attempts = pending.attempts + 1)
            pendingAcks[messageId] = next
            next
        }

        val accepted = socket?.send(retry.rawMessage) == true
        if (!accepted) {
            synchronized(pendingAcks) {
                pendingAcks.remove(messageId)
            }
            listener.onRelayRequestState(
                RelayRequestState(
                    type = retry.type,
                    label = requestLabel(retry.type),
                    phase = "failed",
                    messageId = retry.messageId,
                    attempts = retry.attempts,
                    updatedAt = java.time.Instant.now().toString()
                )
            )
            listener.onError("Relay retry failed for ${retry.type}. Reconnect and try again.")
            return
        }
        listener.onRelayRequestState(
            RelayRequestState(
                type = retry.type,
                label = requestLabel(retry.type),
                phase = "retrying",
                messageId = retry.messageId,
                attempts = retry.attempts,
                updatedAt = java.time.Instant.now().toString()
            )
        )
        scheduleAckTimeout(messageId)
    }

    private fun handleAck(payload: JSONObject) {
        val messageId = payload.optString("message_id", "")
        if (messageId.isBlank()) {
            return
        }
        val status = payload.optString("status", "accepted")
        val pending = synchronized(pendingAcks) {
            pendingAcks.remove(messageId)
        }
        listener.onRelayRequestState(
            RelayRequestState(
                type = payload.optString("message_type", pending?.type.orEmpty()),
                label = requestLabel(payload.optString("message_type", pending?.type.orEmpty())),
                phase = if (status == "duplicate") "duplicate" else "acknowledged",
                messageId = messageId,
                attempts = pending?.attempts ?: 1,
                updatedAt = java.time.Instant.now().toString()
            )
        )
        if (status == "duplicate") {
            listener.onHealthCheck("Relay already accepted the request. Syncing result.")
        }
    }

    private fun clearPendingAcks(reason: String) {
        val pendingTypes = synchronized(pendingAcks) {
            val types = pendingAcks.values.map { it.type }.distinct()
            pendingAcks.clear()
            types
        }
        if (pendingTypes.isNotEmpty()) {
            listener.onRelayRequestState(
                RelayRequestState(
                    label = "Relay request",
                    phase = "failed",
                    updatedAt = java.time.Instant.now().toString()
                )
            )
            listener.onError(reason)
        }
    }

    private fun requestLabel(type: String): String = when (type) {
        "session.prompt" -> "Prompt"
        "session.prompt.queue" -> "Queue"
        "session.prompt.edit" -> "Edit"
        "session.turn.interrupt" -> "Stop"
        "session.create" -> "New chat"
        "session.create_ephemeral" -> "New chat"
        "approval.decision" -> "Approval"
        "git.request" -> "Git"
        "power.trust.request" -> "PC trust"
        "power.trust.verify" -> "PC verify"
        "power.request" -> "PC command"
        else -> type.ifBlank { "Relay request" }
    }

    private fun healthUrlFor(url: String): String {
        return httpUrlFor(url, "/health")
    }

    private fun pairUrlFor(url: String): String {
        return httpUrlFor(url, "/pair")
    }

    private fun gitAuditUrlFor(url: String, sessionId: String, limit: Int): String {
        return "${httpUrlFor(url, "/git/audit")}?session_id=${encodeQuery(sessionId)}&limit=${limit.coerceIn(1, 100)}"
    }

    private fun httpUrlFor(url: String, path: String): String {
        val base = when {
            url.startsWith("ws://") -> url.replaceFirst("ws://", "http://")
            url.startsWith("wss://") -> url.replaceFirst("wss://", "https://")
            else -> throw IllegalArgumentException("Relay URL must start with ws:// or wss://")
        }.trimEnd('/')
        return "$base$path"
    }

    private fun errorDetail(raw: String): String {
        if (raw.isBlank()) {
            return ""
        }

        return runCatching {
            val json = JSONObject(raw)
            val detail = json.optString("detail", json.optString("error", ""))
            if (detail.isBlank()) "" else ": $detail"
        }.getOrDefault("")
    }

    private fun addAuthHeaders(builder: Request.Builder, token: String) {
        if (token.isBlank()) {
            return
        }

        builder
            .header("Authorization", "Bearer $token")
            .header("X-Relay-Auth-Token", token)
    }

    private fun addShortHttpHeaders(builder: Request.Builder) {
        builder
            .header("Connection", "close")
            .header("Accept", "application/json")
    }

    private fun summarizeHealth(raw: String): String {
        val json = JSONObject(raw)
        if (json.optBoolean("auth_required", false) && json.isNull("counts")) {
            return "health reachable: dev token required for diagnostics"
        }
        val counts = json.optJSONObject("counts")
        val listen = json.optJSONObject("listen")
        val hosts = counts?.optInt("online_hosts") ?: counts?.optInt("hosts") ?: 0
        val sessions = counts?.optInt("sessions") ?: 0
        val clients = counts?.optInt("clients") ?: 0
        val cachedEvents = counts?.optInt("cached_timeline_events") ?: 0
        val lan = listen?.optBoolean("lan_access_enabled") ?: false
        return "health ok: hosts=$hosts, sessions=$sessions, clients=$clients, cached_events=$cachedEvents, lan=$lan"
    }

    private fun parseHealthDiagnostics(raw: String, healthUrl: String): ConnectionDiagnostics {
        val json = JSONObject(raw)
        val counts = json.optJSONObject("counts")
        val websocket = json.optJSONObject("websocket")
        val listen = json.optJSONObject("listen")
        val storage = json.optJSONObject("storage")
        val version = json.optJSONObject("version")
        return ConnectionDiagnostics(
            healthUrl = healthUrl,
            checkedAt = json.optString("checked_at", ""),
            authRequired = json.optBoolean("auth_required", false),
            detailed = counts != null,
            totalHosts = counts?.optNullableInt("hosts"),
            onlineHosts = counts?.optNullableInt("online_hosts"),
            sessions = counts?.optNullableInt("sessions"),
            clients = counts?.optNullableInt("clients"),
            pairedDevices = counts?.optNullableInt("paired_devices"),
            cachedTimelineEvents = counts?.optNullableInt("cached_timeline_events"),
            websocketConnections = websocket?.optNullableInt("connections"),
            wsPingIntervalMs = websocket?.optNullableInt("ping_interval_ms"),
            wsStaleTimeoutMs = websocket?.optNullableInt("stale_timeout_ms"),
            publicWebsocketUrl = listen?.optString("public_websocket_url", "")?.takeIf { it.isNotBlank() },
            publicHealthUrl = listen?.optString("public_health_url", "")?.takeIf { it.isNotBlank() },
            storageKind = storage?.optString("kind", "")?.takeIf { it.isNotBlank() },
            storagePath = storage?.optString("path", "")?.takeIf { it.isNotBlank() },
            relayVersion = version?.optString("relay", "")?.takeIf { it.isNotBlank() },
            relayProtocolVersion = version?.takeIf { it.has("protocol") && !it.isNull("protocol") }?.optString("protocol")
        )
    }

    private fun JSONObject.optNullableInt(name: String): Int? {
        if (!has(name) || isNull(name)) {
            return null
        }
        return optInt(name)
    }

    private fun parseGitAuditItem(json: JSONObject): GitAuditItem = GitAuditItem(
        eventId = json.optString("event_id", UUID.randomUUID().toString()),
        auditId = json.optString("audit_id", ""),
        sessionId = json.optString("session_id", ""),
        hostId = json.optString("host_id", ""),
        phase = json.optString("phase", ""),
        action = json.optString("action", ""),
        filePath = json.optString("file_path", ""),
        deviceId = json.optJSONObject("device")?.optString("device_id", "") ?: "",
        deviceDisplayName = json.optJSONObject("device")?.optString("display_name", "") ?: "",
        resultOk = json.takeIf { it.has("result_ok") && !it.isNull("result_ok") }?.optBoolean("result_ok"),
        resultMessage = json.optString("result_message", ""),
        changedFileCount = json.takeIf { it.has("changed_file_count") && !it.isNull("changed_file_count") }?.optInt("changed_file_count"),
        createdAt = json.optString("created_at", "")
    )

    private fun parseNotificationEvent(json: JSONObject): NotificationEvent = NotificationEvent(
        notificationId = json.optString("notification_id", UUID.randomUUID().toString()),
        kind = json.optString("kind", "update"),
        sessionId = json.optString("session_id", "").takeIf { it.isNotBlank() },
        hostId = json.optString("host_id", "").takeIf { it.isNotBlank() },
        title = json.optString("title", "Codex update"),
        summary = json.optString("summary", ""),
        createdAt = json.optString("created_at", "")
    )

    private fun parseSession(json: JSONObject): CodexSession {
        val status = json.optString("status", "idle")
        val summary = json.optString("summary", "")
        val updatedAt = json.optString("updated_at", "")
        return CodexSession(
            sessionId = json.getString("session_id"),
            hostId = json.getString("host_id"),
            projectName = json.optString("project_name", "Codex Session"),
            repoPath = json.optString("repo_path", ""),
            branch = json.optString("branch", "unknown"),
            status = status,
            summary = summary,
            updatedAt = updatedAt,
            stage = parseSessionStage(json.optJSONObject("stage"), status, summary, updatedAt)
        )
    }

    private fun parseSessionSyncEntry(json: JSONObject): SessionSyncEntry {
        val dirtyReasonsArray = json.optJSONArray("dirty_reasons")
        val dirtyReasons = if (dirtyReasonsArray == null) {
            emptyList()
        } else {
            List(dirtyReasonsArray.length()) { index -> dirtyReasonsArray.optString(index, "") }
                .filter { it.isNotBlank() }
        }
        val deviceSeen = json.optJSONObject("device_seen")
        return SessionSyncEntry(
            session = parseSession(json.getJSONObject("session")),
            snapshotRevision = json.optLong("snapshot_revision", 0L),
            stageRevision = json.optLong("stage_revision", 0L),
            syncRevision = json.optLong("sync_revision", 0L),
            timelineNewestCursor = json.optLong("timeline_newest_cursor", 0L),
            timelineOldestCursor = json.takeIf { it.has("timeline_oldest_cursor") && !it.isNull("timeline_oldest_cursor") }
                ?.optLong("timeline_oldest_cursor"),
            dirty = json.optBoolean("dirty", false),
            dirtyReasons = dirtyReasons,
            recommendedAction = json.optString("recommended_action", "none"),
            archivedAt = deviceSeen?.optString("archived_at", "")?.takeIf { it.isNotBlank() },
            pinnedAt = deviceSeen?.optString("pinned_at", "")?.takeIf { it.isNotBlank() }
        )
    }

    private fun parseSessionStage(json: JSONObject?, status: String, summary: String, updatedAt: String): SessionStage {
        if (json == null) {
            return SessionStage.fromStatus(status, summary, updatedAt)
        }
        return SessionStage(
            type = json.optString("type", "").ifBlank { SessionStage.fromStatus(status, summary, updatedAt).type },
            label = json.optString("label", "").ifBlank { SessionStage.fromStatus(status, summary, updatedAt).label },
            summary = json.optString("summary", "").ifBlank { summary },
            severity = json.optString("severity", "").ifBlank { SessionStage.fromStatus(status, summary, updatedAt).severity },
            updatedAt = json.optString("updated_at", "").ifBlank { updatedAt }
        )
    }

    private fun parseHostSnapshot(payload: JSONObject): HostNode {
        val host = payload.getJSONObject("host")
        val capabilitiesArray = host.optJSONArray("capabilities")
        val capabilities = if (capabilitiesArray == null) {
            emptyList()
        } else {
            List(capabilitiesArray.length()) { index -> capabilitiesArray.optString(index, "") }
                .filter { it.isNotBlank() }
        }
        return HostNode(
            hostId = host.getString("host_id"),
            displayName = host.optString("display_name", host.optString("host_id", "Host")),
            status = host.optString("status", "offline"),
            capabilities = capabilities,
            sessionCount = payload.optInt("session_count", 0),
            lastSeenAt = host.optString("last_seen_at", ""),
            bridgeVersion = host.optString("bridge_version", ""),
            protocolVersion = host.optString("protocol_version", ""),
            kind = host.optString("kind", "")
        )
    }

    private fun parsePowerStatus(payload: JSONObject): PowerStatus {
        val status = payload.optJSONObject("status") ?: payload
        return PowerStatus(
            hostId = payload.optString("host_id", status.optString("host_id", "")),
            platform = status.optString("platform", ""),
            powerControlEnabled = status.optBoolean("power_control_enabled", false),
            allowKeepAwake = status.optBoolean("allow_keep_awake", false),
            allowLock = status.optBoolean("allow_lock", false),
            keepAwakeActive = status.optBoolean("keep_awake_active", false),
            keepAwakeUntil = status.optString("keep_awake_until", "").takeIf { it.isNotBlank() },
            mockMode = status.optBoolean("mock_mode", false),
            policyPath = status.optString("policy_path", ""),
            checkedAt = status.optString("checked_at", "")
        )
    }

    private fun parsePowerTrustChallenge(json: JSONObject): PowerTrustChallenge = PowerTrustChallenge(
        hostId = json.optString("host_id", ""),
        challengeId = json.optString("challenge_id", ""),
        deviceId = json.optString("device_id", ""),
        expiresAt = json.optString("expires_at", ""),
        message = json.optString("message", "Enter the code shown on your computer.")
    )

    private fun parsePowerTrust(json: JSONObject): PowerTrust {
        val capabilitiesArray = json.optJSONArray("capabilities")
        val capabilities = if (capabilitiesArray == null) {
            emptyList()
        } else {
            List(capabilitiesArray.length()) { index -> capabilitiesArray.optString(index, "") }
                .filter { it.isNotBlank() }
        }
        return PowerTrust(
            hostId = json.optString("host_id", ""),
            deviceId = json.optString("device_id", ""),
            capabilities = capabilities,
            expiresAt = json.optString("expires_at", "").takeIf { it.isNotBlank() }
        )
    }

    private fun parsePowerResult(json: JSONObject): PowerResult = PowerResult(
        hostId = json.optString("host_id", ""),
        deviceId = json.optString("device_id", ""),
        action = json.optString("action", ""),
        status = json.optString("status", ""),
        reason = json.optString("reason", ""),
        expiresAt = json.optString("expires_at", "").takeIf { it.isNotBlank() }
    )

    private fun promptDraftPayload(sessionId: String, draft: PromptDraft): JSONObject {
        val input = JSONArray()
        if (draft.text.isNotBlank()) {
            input.put(
                JSONObject()
                    .put("type", "text")
                    .put("text", draft.text)
            )
        }
        draft.attachments.forEach { attachment ->
            input.put(
                JSONObject()
                    .put("type", "image")
                    .put("attachment_id", attachment.attachmentId)
                    .put("name", attachment.displayName)
                    .put("mime_type", attachment.mimeType)
                    .put("size_bytes", attachment.sizeBytes)
                    .put("data_url", attachment.dataUrl)
                    .put("width", attachment.width ?: JSONObject.NULL)
                    .put("height", attachment.height ?: JSONObject.NULL)
            )
        }

        val options = JSONObject()
            .put("reasoning_effort", draft.reasoningEffort)
            .put("plan_mode", draft.planModeOnce)
        if (draft.goalModeOnce) {
            options.put(
                "goal",
                JSONObject().put("objective", draft.goalObjective)
            )
        }

        return JSONObject()
            .put("session_id", sessionId)
            .put("text", draft.text)
            .put("input", input)
            .put("options", options)
            .put("client_request_id", draft.clientRequestId)
    }

    private fun parseTimelineEvent(json: JSONObject): TimelineItem {
        val payload = json.optJSONObject("payload")
        return TimelineItem(
            eventId = json.optString("event_id", UUID.randomUUID().toString()),
            sessionId = json.getString("session_id"),
            type = json.optString("type", "event"),
            title = json.optString("title", "Timeline event"),
            summary = json.optString("summary", ""),
            createdAt = json.optString("created_at", ""),
            cursor = json.optString("cursor").takeIf { it.isNotBlank() },
            payloadJson = payload?.toString().orEmpty(),
            turnId = firstNonBlank(
                json.optString("turn_id", ""),
                payload?.optString("turn_id", "").orEmpty(),
                payload?.optString("active_turn_id", "").orEmpty()
            ),
            itemId = firstNonBlank(
                json.optString("item_id", ""),
                payload?.optString("item_id", "").orEmpty()
            ),
            clientRequestId = firstNonBlank(
                json.optString("client_request_id", ""),
                payload?.optString("client_request_id", "").orEmpty()
            )
        )
    }

    private fun parseApproval(json: JSONObject): ApprovalItem = ApprovalItem(
        approvalId = json.getString("approval_id"),
        sessionId = json.getString("session_id"),
        kind = json.optString("kind", "action"),
        title = json.optString("title", "Approval requested"),
        summary = json.optString("summary", ""),
        command = json.optString("command", ""),
        riskLevel = json.optString("risk_level", "unknown"),
        status = json.optString("status", "pending"),
        requestedAt = json.optString("requested_at", "")
    )

    private fun parseGitSnapshot(json: JSONObject): GitSnapshot {
        val filesJson = json.optJSONArray("files")
        val files = if (filesJson == null) {
            emptyList()
        } else {
            List(filesJson.length()) { index ->
                val item = filesJson.getJSONObject(index)
                GitFileChange(
                    path = item.optString("path", ""),
                    indexStatus = item.optString("index_status", ""),
                    worktreeStatus = item.optString("worktree_status", ""),
                    tracked = item.optBoolean("tracked", true)
                )
            }
        }
        val result = json.optJSONObject("result")
        return GitSnapshot(
            sessionId = json.getString("session_id"),
            action = json.optString("action", "status"),
            repoPath = json.optString("repo_path", ""),
            branch = json.optString("branch", "unknown"),
            isGitRepo = json.optBoolean("is_git_repo", false),
            statusSummary = json.optString("status_summary", ""),
            trackedFileCount = json.optInt("tracked_file_count", files.count { it.tracked }),
            untrackedFileCount = json.optInt("untracked_file_count", files.count { !it.tracked }),
            commitStrategy = json.optString("commit_strategy", "tracked_only"),
            files = files,
            diffStat = json.optString("diff_stat", ""),
            selectedFilePath = json.optString("selected_file_path", ""),
            selectedFileDiff = json.optString("selected_file_diff", ""),
            selectedFileDiffTruncated = json.optBoolean("selected_file_diff_truncated", false),
            resultOk = result?.takeIf { it.has("ok") }?.optBoolean("ok"),
            resultMessage = result?.optString("message", "") ?: "",
            error = json.optString("error", ""),
            updatedAt = json.optString("updated_at", "")
        )
    }

    private data class PendingAck(
        val messageId: String,
        val type: String,
        val rawMessage: String,
        val attempts: Int,
        val disconnectedPolls: Int
    )

    companion object {
        const val DEFAULT_RELAY_URL = "ws://10.0.2.2:8787"
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
        private const val WEBSOCKET_PING_SECONDS = 25L
        private const val ACK_TIMEOUT_MS = 2500L
        private const val ACK_MAX_RETRIES = 1
        private const val ACK_MAX_DISCONNECTED_POLLS = 12
        private val ACK_REQUIRED_TYPES = setOf(
            "approval.decision",
            "git.request",
            "power.trust.request",
            "power.trust.verify",
            "power.request",
            "session.create",
            "session.create_ephemeral",
            "session.prompt",
            "session.prompt.queue",
            "session.prompt.edit",
            "session.turn.interrupt",
            "session.sync.ack",
            "session.archive.update",
            "session.pin.update"
        )

        private fun encodeQuery(value: String): String =
            java.net.URLEncoder.encode(value, Charsets.UTF_8.name())

        private fun firstNonBlank(vararg values: String): String? =
            values.firstOrNull { it.isNotBlank() }

        private fun defaultHttpClient(): OkHttpClient =
            OkHttpClient.Builder()
                .connectTimeout(8, TimeUnit.SECONDS)
                .readTimeout(12, TimeUnit.SECONDS)
                .writeTimeout(8, TimeUnit.SECONDS)
                .callTimeout(15, TimeUnit.SECONDS)
                .pingInterval(WEBSOCKET_PING_SECONDS, TimeUnit.SECONDS)
                .build()
    }
}
