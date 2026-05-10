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

    fun sessions(): List<CodexSession> = readJsonArray(KEY_SESSIONS).mapNotNull { item ->
        runCatching {
            CodexSession(
                sessionId = item.getString("session_id"),
                hostId = item.getString("host_id"),
                projectName = item.optString("project_name", "Codex Session"),
                repoPath = item.optString("repo_path", ""),
                branch = item.optString("branch", "unknown"),
                status = item.optString("status", "idle"),
                summary = item.optString("summary", ""),
                updatedAt = item.optString("updated_at", "")
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
                cursor = item.optString("cursor").takeIf { it.isNotBlank() }
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
                    .put("cursor", event.cursor ?: "")
            )
        }
        preferences.edit().putString(KEY_TIMELINE, json.toString()).apply()
    }

    fun clearSessionCache() {
        preferences.edit()
            .remove(KEY_SELECTED_SESSION_ID)
            .remove(KEY_SESSIONS)
            .remove(KEY_TIMELINE)
            .apply()
    }

    private fun readJsonArray(key: String): List<JSONObject> {
        val raw = preferences.getString(key, null) ?: return emptyList()
        return runCatching {
            val array = JSONArray(raw)
            List(array.length()) { index -> array.getJSONObject(index) }
        }.getOrDefault(emptyList())
    }

    private companion object {
        const val PREFERENCES_NAME = "relay_settings"
        const val KEY_RELAY_URL = "relay_url"
        const val KEY_PAIRING_TOKEN = "pairing_token"
        const val KEY_DEVICE_TOKEN = "device_token"
        const val KEY_DEVICE_ID = "device_id"
        const val KEY_SELECTED_SESSION_ID = "selected_session_id"
        const val KEY_SESSIONS = "sessions"
        const val KEY_TIMELINE = "timeline"
        const val MAX_SESSIONS = 20
        const val MAX_TIMELINE_ITEMS = 100
    }
}
