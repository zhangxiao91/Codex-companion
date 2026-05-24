package dev.codexmobile.companion

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

class RelaySettings(context: Context) {
    private val preferences = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
    private val secureTokenStore = SecureTokenStore(context)

    fun relayUrl(): String = preferences.getString(KEY_RELAY_URL, RelayClient.DEFAULT_RELAY_URL)
        ?: RelayClient.DEFAULT_RELAY_URL

    fun saveRelayUrl(url: String) {
        preferences.edit().putString(KEY_RELAY_URL, url).apply()
    }

    fun pairingToken(): String = secureTokenStore.read(KEY_PAIRING_TOKEN)

    fun savePairingToken(token: String) {
        secureTokenStore.write(KEY_PAIRING_TOKEN, token)
    }

    fun clearDevicePairing() {
        preferences.edit().remove(KEY_DEVICE_ID).apply()
        secureTokenStore.remove(KEY_DEVICE_TOKEN)
    }

    fun deviceToken(): String = secureTokenStore.read(KEY_DEVICE_TOKEN)

    fun deviceId(): String = preferences.getString(KEY_DEVICE_ID, "") ?: ""

    fun saveDevicePairing(deviceId: String, token: String) {
        preferences.edit()
            .putString(KEY_DEVICE_ID, deviceId)
            .apply()
        secureTokenStore.write(KEY_DEVICE_TOKEN, token)
    }

    fun selectedSessionId(): String? = preferences.getString(KEY_SELECTED_SESSION_ID, null)

    fun saveSelectedSessionId(sessionId: String?) {
        preferences.edit().putString(KEY_SELECTED_SESSION_ID, sessionId).apply()
    }

    fun pinnedSessionIds(): Set<String> =
        preferences.getStringSet(KEY_PINNED_SESSION_IDS, emptySet()) ?: emptySet()

    fun savePinnedSessionIds(sessionIds: Set<String>) {
        preferences.edit().putStringSet(KEY_PINNED_SESSION_IDS, sessionIds).apply()
    }

    fun sessions(): List<CodexSession> = readJsonArray(KEY_SESSIONS).mapNotNull { item ->
        runCatching {
            val status = item.optString("status", "idle")
            val summary = item.optString("summary", "")
            val updatedAt = item.optString("updated_at", "")
            CodexSession(
                sessionId = item.getString("session_id"),
                hostId = item.getString("host_id"),
                projectName = item.optString("project_name", "Codex Session"),
                repoPath = item.optString("repo_path", ""),
                branch = item.optString("branch", "unknown"),
                status = status,
                summary = summary,
                updatedAt = updatedAt,
                stage = readSessionStage(item.optJSONObject("stage"), status, summary, updatedAt)
            )
        }.getOrNull()
    }

    fun saveSessions(sessions: List<CodexSession>) {
        val json = JSONArray()
        sessions.take(MAX_SESSIONS).forEach { session ->
            json.put(
                JSONObject()
                    .put("session_id", session.sessionId)
                    .put("host_id", session.hostId)
                    .put("project_name", session.projectName)
                    .put("repo_path", session.repoPath)
                    .put("branch", session.branch)
                    .put("status", session.status)
                    .put("summary", session.summary)
                    .put("updated_at", session.updatedAt)
                    .put(
                        "stage",
                        JSONObject()
                            .put("type", session.stage.type)
                            .put("label", session.stage.label)
                            .put("summary", session.stage.summary)
                            .put("severity", session.stage.severity)
                            .put("updated_at", session.stage.updatedAt)
                    )
            )
        }
        preferences.edit().putString(KEY_SESSIONS, json.toString()).apply()
    }

    fun timeline(): List<TimelineItem> = readJsonArray(KEY_TIMELINE).mapNotNull { item ->
        runCatching {
            TimelineItem(
                eventId = item.getString("event_id"),
                sessionId = item.getString("session_id"),
                type = item.optString("type", "event"),
                title = item.optString("title", "Timeline event"),
                summary = item.optString("summary", ""),
                createdAt = item.optString("created_at", ""),
                cursor = item.optString("cursor").takeIf { it.isNotBlank() },
                payloadJson = item.optJSONObject("payload")?.toString().orEmpty(),
                turnId = item.optString("turn_id").takeIf { it.isNotBlank() }
                    ?: item.optJSONObject("payload")?.optString("turn_id")?.takeIf { it.isNotBlank() }
                    ?: item.optJSONObject("payload")?.optString("active_turn_id")?.takeIf { it.isNotBlank() },
                itemId = item.optString("item_id").takeIf { it.isNotBlank() }
                    ?: item.optJSONObject("payload")?.optString("item_id")?.takeIf { it.isNotBlank() },
                clientRequestId = item.optString("client_request_id").takeIf { it.isNotBlank() }
                    ?: item.optJSONObject("payload")?.optString("client_request_id")?.takeIf { it.isNotBlank() }
            )
        }.getOrNull()
    }

    fun saveTimeline(timeline: List<TimelineItem>) {
        val json = JSONArray()
        timeline.take(MAX_TIMELINE_ITEMS).forEach { event ->
            json.put(
                JSONObject()
                    .put("event_id", event.eventId)
                    .put("session_id", event.sessionId)
                    .put("type", event.type)
                    .put("title", event.title)
                    .put("summary", event.summary)
                    .put("created_at", event.createdAt)
                    .put("cursor", event.cursor ?: "")
                    .put("turn_id", event.turnId ?: "")
                    .put("item_id", event.itemId ?: "")
                    .put("client_request_id", event.clientRequestId ?: "")
                    .put("payload", runCatching { JSONObject(event.payloadJson) }.getOrNull() ?: JSONObject())
            )
        }
        preferences.edit().putString(KEY_TIMELINE, json.toString()).apply()
    }

    fun clearSessionCache() {
        preferences.edit()
            .remove(KEY_SELECTED_SESSION_ID)
            .remove(KEY_SESSIONS)
            .remove(KEY_TIMELINE)
            .remove(KEY_PINNED_SESSION_IDS)
            .apply()
    }

    private fun readJsonArray(key: String): List<JSONObject> {
        val raw = preferences.getString(key, null) ?: return emptyList()
        return runCatching {
            val array = JSONArray(raw)
            List(array.length()) { index -> array.getJSONObject(index) }
        }.getOrDefault(emptyList())
    }

    private fun readSessionStage(json: JSONObject?, status: String, summary: String, updatedAt: String): SessionStage {
        if (json == null) {
            return SessionStage.fromStatus(status, summary, updatedAt)
        }
        val fallback = SessionStage.fromStatus(status, summary, updatedAt)
        return SessionStage(
            type = json.optString("type", fallback.type),
            label = json.optString("label", fallback.label),
            summary = json.optString("summary", fallback.summary),
            severity = json.optString("severity", fallback.severity),
            updatedAt = json.optString("updated_at", fallback.updatedAt)
        )
    }

    private companion object {
        const val PREFERENCES_NAME = "relay_settings"
        const val KEY_RELAY_URL = "relay_url"
        const val KEY_PAIRING_TOKEN = "pairing_token"
        const val KEY_DEVICE_TOKEN = "device_token"
        const val KEY_DEVICE_ID = "device_id"
        const val KEY_SELECTED_SESSION_ID = "selected_session_id"
        const val KEY_PINNED_SESSION_IDS = "pinned_session_ids"
        const val KEY_SESSIONS = "sessions"
        const val KEY_TIMELINE = "timeline"
        const val MAX_SESSIONS = 20
        const val MAX_TIMELINE_ITEMS = 10000
    }
}
