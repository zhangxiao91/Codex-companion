package dev.codexmobile.companion

import androidx.lifecycle.ViewModel
import java.time.Instant
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update

class RelayViewModel(
    private val settings: RelaySettings
) : ViewModel(), RelayClient.Listener {
    private val relayClient = RelayClient(this)
    private val _uiState = MutableStateFlow(
        RelayUiState(
            relayUrl = settings.relayUrl(),
            sessions = settings.sessions(),
            selectedSessionId = settings.selectedSessionId(),
            timeline = settings.timeline()
        )
    )
    val uiState: StateFlow<RelayUiState> = _uiState

    fun connect() {
        _uiState.update { it.copy(connectionStatus = "Connecting", lastError = null) }
        relayClient.connect(_uiState.value.relayUrl)
    }

    fun saveRelayUrl(url: String) {
        val normalizedUrl = url.trim()
        if (!isValidRelayUrl(normalizedUrl)) {
            _uiState.update { it.copy(lastError = "Relay URL must start with ws:// or wss://") }
            return
        }

        settings.saveRelayUrl(normalizedUrl)
        settings.clearSessionCache()
        _uiState.update {
            it.copy(
                relayUrl = normalizedUrl,
                connectionStatus = "Disconnected",
                sessions = emptyList(),
                selectedSessionId = null,
                timeline = emptyList(),
                lastConnectedAt = null,
                lastError = null
            )
        }
        connect()
    }

    fun testConnection() {
        _uiState.update { it.copy(lastError = null, lastHealthCheck = "Checking ${it.relayUrl}/health") }
        relayClient.testHealth(_uiState.value.relayUrl)
    }

    fun selectSession(sessionId: String) {
        val afterCursor = _uiState.value.timeline
            .filter { it.sessionId == sessionId }
            .mapNotNull { it.cursor?.toLongOrNull() }
            .maxOrNull()
            ?.toString()
        _uiState.update { it.copy(selectedSessionId = sessionId) }
        settings.saveSelectedSessionId(sessionId)
        relayClient.requestTimeline(sessionId, afterCursor)
    }

    fun sendPrompt(text: String) {
        val sessionId = _uiState.value.selectedSessionId ?: return
        if (text.isBlank()) {
            return
        }
        relayClient.sendPrompt(sessionId, text.trim())
    }

    override fun onConnected() {
        _uiState.update {
            it.copy(
                connectionStatus = "Online",
                lastConnectedAt = Instant.now().toString(),
                lastError = null
            )
        }
        _uiState.value.selectedSessionId?.let { sessionId ->
            relayClient.requestTimeline(sessionId, latestCursorFor(sessionId))
        }
    }

    override fun onDisconnected(reason: String) {
        _uiState.update { it.copy(connectionStatus = "Disconnected", lastError = reason) }
    }

    override fun onSessionSnapshot(session: CodexSession) {
        _uiState.update { state ->
            val sessions = listOf(session) + state.sessions.filter { it.sessionId != session.sessionId }
            val selectedSessionId = state.selectedSessionId ?: session.sessionId
            state.copy(sessions = sessions, selectedSessionId = selectedSessionId)
        }
        val state = _uiState.value
        settings.saveSessions(state.sessions)
        settings.saveSelectedSessionId(state.selectedSessionId)
        if (_uiState.value.selectedSessionId == session.sessionId) {
            relayClient.requestTimeline(session.sessionId, latestCursorFor(session.sessionId))
        }
    }

    override fun onTimelineEvent(event: TimelineItem) {
        _uiState.update { state ->
            val timeline = (listOf(event) + state.timeline.filter { it.eventId != event.eventId })
                .take(MAX_TIMELINE_ITEMS)
            state.copy(timeline = timeline)
        }
        settings.saveTimeline(_uiState.value.timeline)
    }

    override fun onHealthCheck(summary: String) {
        _uiState.update { it.copy(lastHealthCheck = summary, lastError = null) }
    }

    override fun onError(message: String) {
        _uiState.update { it.copy(lastError = message) }
    }

    override fun onCleared() {
        relayClient.close()
        super.onCleared()
    }

    private companion object {
        const val MAX_TIMELINE_ITEMS = 200

        fun isValidRelayUrl(url: String): Boolean =
            url.startsWith("ws://") || url.startsWith("wss://")
    }

    private fun latestCursorFor(sessionId: String): String? = _uiState.value.timeline
        .filter { it.sessionId == sessionId }
        .mapNotNull { it.cursor?.toLongOrNull() }
        .maxOrNull()
        ?.toString()
}
