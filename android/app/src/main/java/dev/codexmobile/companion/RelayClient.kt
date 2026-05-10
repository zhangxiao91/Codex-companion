package dev.codexmobile.companion

import java.util.UUID
import okhttp3.OkHttpClient
import okhttp3.Request
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
        fun onTimelineEvent(event: TimelineItem)
        fun onError(message: String)
    }

    private var socket: WebSocket? = null

    fun connect(url: String = DEFAULT_RELAY_URL) {
        close()
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

    private fun handleMessage(raw: String) {
        runCatching {
            val message = JSONObject(raw)
            when (val type = message.getString("type")) {
                "session.snapshot" -> listener.onSessionSnapshot(
                    parseSession(message.getJSONObject("payload").getJSONObject("session"))
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
        socket?.send(message.toString())
    }

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

    companion object {
        const val DEFAULT_RELAY_URL = "ws://10.0.2.2:8787"
    }
}
