package dev.codexmobile.companion

import androidx.lifecycle.ViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update

class RelayViewModel : ViewModel(), RelayClient.Listener {
    private val relayClient = RelayClient(this)
    private val _uiState = MutableStateFlow(RelayUiState())
    val uiState: StateFlow<RelayUiState> = _uiState

    fun connect() {
        _uiState.update { it.copy(connectionStatus = "Connecting", lastError = null) }
        relayClient.connect(_uiState.value.relayUrl)
    }

    fun selectSession(sessionId: String) {
        val afterCursor = _uiState.value.timeline
            .filter { it.sessionId == sessionId }
            .mapNotNull { it.cursor?.toLongOrNull() }
            .maxOrNull()
            ?.toString()
        _uiState.update { it.copy(selectedSessionId = sessionId) }
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
        _uiState.update { it.copy(connectionStatus = "Online", lastError = null) }
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
        if (_uiState.value.selectedSessionId == session.sessionId) {
            relayClient.requestTimeline(session.sessionId)
        }
    }

    override fun onTimelineEvent(event: TimelineItem) {
        _uiState.update { state ->
            val timeline = (listOf(event) + state.timeline.filter { it.eventId != event.eventId })
                .take(MAX_TIMELINE_ITEMS)
            state.copy(timeline = timeline)
        }
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
    }
}
