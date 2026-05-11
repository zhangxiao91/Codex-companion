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
        fun onSessionSnapshot(session: CodexSession)
        fun onApprovalRequest(approval: ApprovalItem)
        fun onGitSnapshot(snapshot: GitSnapshot)
        fun onGitAudit(sessionId: String, events: List<GitAuditItem>)
        fun onTimelineEvent(event: TimelineItem)
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

    fun requestTimeline(sessionId: String, afterCursor: String? = null) {
        val payload = JSONObject()
            .put("session_id", sessionId)
            .put("limit", 100)
        if (!afterCursor.isNullOrBlank()) {
            payload.put("after_cursor", afterCursor)
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
                                listener.onError("Pairing failed: HTTP ${it.code}")
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
                "session.snapshot" -> listener.onSessionSnapshot(
                    parseSession(message.getJSONObject("payload").getJSONObject("session"))
                )

                "approval.request" -> listener.onApprovalRequest(
                    parseApproval(message.getJSONObject("payload").getJSONObject("approval"))
                )

                "git.snapshot" -> listener.onGitSnapshot(
                    parseGitSnapshot(message.getJSONObject("payload").getJSONObject("snapshot"))
                )

                "timeline.event" -> listener.onTimelineEvent(
                    parseTimelineEvent(message.getJSONObject("payload").getJSONObject("event"))
                )

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

    private fun parseSession(json: JSONObject): CodexSession = CodexSession(
        sessionId = json.getString("session_id"),
        hostId = json.getString("host_id"),
        projectName = json.optString("project_name", "Codex Session"),
        repoPath = json.optString("repo_path", ""),
        branch = json.optString("branch", "unknown"),
        status = json.optString("status", "idle"),
        summary = json.optString("summary", ""),
        updatedAt = json.optString("updated_at", "")
    )

    private fun parseTimelineEvent(json: JSONObject): TimelineItem = TimelineItem(
        eventId = json.optString("event_id", UUID.randomUUID().toString()),
        sessionId = json.getString("session_id"),
        type = json.optString("type", "event"),
        title = json.optString("title", "Timeline event"),
        summary = json.optString("summary", ""),
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
