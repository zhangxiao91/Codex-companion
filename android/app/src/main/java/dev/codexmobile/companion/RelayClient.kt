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

class RelayClient(
    private val listener: Listener,
    private val client: OkHttpClient = OkHttpClient()
) {
    interface Listener {
        fun onConnected()
        fun onDisconnected(reason: String)
        fun onHostSnapshot(host: HostNode)
        fun onSessionSnapshot(session: CodexSession)
        fun onApprovalRequest(approval: ApprovalItem)
        fun onGitSnapshot(snapshot: GitSnapshot)
        fun onGitAudit(sessionId: String, events: List<GitAuditItem>)
        fun onPowerStatus(status: PowerStatus)
        fun onPowerTrustChallenge(challenge: PowerTrustChallenge)
        fun onPowerTrustGranted(trust: PowerTrust)
        fun onPowerResult(result: PowerResult)
        fun onTimelineEvent(event: TimelineItem)
        fun onTimelinePage(sessionId: String, events: List<TimelineItem>, hasMoreBefore: Boolean, source: String)
        fun onHealthCheck(summary: String)
        fun onPairingComplete(deviceId: String, deviceToken: String)
        fun onError(message: String)
    }

    private var socket: WebSocket? = null
    private var authToken: String = ""

    fun connect(url: String = DEFAULT_RELAY_URL, token: String = "") {
        close()
        authToken = token.trim()
        val request = Request.Builder().url(url).build()
        socket = client.newWebSocket(
            request,
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    listener.onConnected()
                    subscribeAll()
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    handleMessage(text)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    listener.onDisconnected(reason.ifBlank { "Closed" })
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    listener.onDisconnected(t.message ?: "WebSocket failed")
                }
            }
        )
    }

    fun close() {
        socket?.close(1000, "closing")
        socket = null
    }

    fun subscribeAll() {
        send("session.subscribe", JSONObject().put("session_id", "*"))
    }

    fun requestTimeline(
        sessionId: String,
        afterCursor: String? = null,
        beforeCursor: String? = null,
        limit: Int = 300,
        cacheOnly: Boolean = false,
        page: Boolean = false
    ) {
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
        send("session.timeline.request", payload)
    }

    fun sendPrompt(sessionId: String, text: String) {
        send(
            "session.prompt",
            JSONObject()
                .put("session_id", sessionId)
                .put("text", text)
        )
    }

    fun createNewChat(hostId: String) {
        send(
            "session.create_ephemeral",
            JSONObject()
                .put("host_id", hostId)
        )
    }

    fun requestGit(
        sessionId: String,
        action: String,
        filePath: String? = null,
        message: String? = null,
        commitStrategy: String? = null
    ) {
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
        send("git.request", payload)
    }

    fun requestPowerTrust(hostId: String) {
        send(
            "power.trust.request",
            JSONObject().put("host_id", hostId)
        )
    }

    fun verifyPowerTrust(hostId: String, challengeId: String, code: String) {
        send(
            "power.trust.verify",
            JSONObject()
                .put("host_id", hostId)
                .put("challenge_id", challengeId)
                .put("code", code)
        )
    }

    fun requestPower(hostId: String, action: String, durationSeconds: Int? = null) {
        val payload = JSONObject()
            .put("host_id", hostId)
            .put("action", action)
        if (durationSeconds != null) {
            payload.put("duration_seconds", durationSeconds)
        }
        send("power.request", payload)
    }

    fun sendApprovalDecision(approvalId: String, decision: String) {
        send(
            "approval.decision",
            JSONObject()
                .put("approval_id", approvalId)
                .put("decision", decision)
        )
    }

    fun testHealth(url: String = DEFAULT_RELAY_URL, token: String = "") {
        runCatching {
            val requestBuilder = Request.Builder().url(healthUrlFor(url))
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

                "session.snapshot" -> listener.onSessionSnapshot(
                    parseSession(message.getJSONObject("payload").getJSONObject("session"))
                )

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

                "error" -> listener.onError(
                    message.getJSONObject("payload").optString("detail", "Relay error")
                )

                else -> listener.onError("Unsupported relay message: $type")
            }
        }.onFailure { error ->
            listener.onError(error.message ?: "Failed to parse relay message")
        }
    }

    private fun send(type: String, payload: JSONObject) {
        val message = JSONObject()
            .put("id", UUID.randomUUID().toString())
            .put("type", type)
            .put("sent_at", java.time.Instant.now().toString())
            .put("payload", payload)
        if (authToken.isNotBlank()) {
            message.put("auth", JSONObject().put("token", authToken))
        }
        socket?.send(message.toString())
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

    private fun parseTimelineEvent(json: JSONObject): TimelineItem = TimelineItem(
        eventId = json.optString("event_id", UUID.randomUUID().toString()),
        sessionId = json.getString("session_id"),
        type = json.optString("type", "event"),
        title = json.optString("title", "Timeline event"),
        summary = json.optString("summary", ""),
        createdAt = json.optString("created_at", ""),
        cursor = json.optString("cursor").takeIf { it.isNotBlank() }
    )

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

    companion object {
        const val DEFAULT_RELAY_URL = "ws://10.0.2.2:8787"
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()

        private fun encodeQuery(value: String): String =
            java.net.URLEncoder.encode(value, Charsets.UTF_8.name())
    }
}
