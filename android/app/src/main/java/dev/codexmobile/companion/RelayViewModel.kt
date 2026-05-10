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
            pairingToken = settings.pairingToken(),
            deviceToken = settings.deviceToken(),
            deviceId = settings.deviceId(),
            sessions = settings.sessions(),
            selectedSessionId = settings.selectedSessionId(),
            timeline = settings.timeline()
        )
    )
    val uiState: StateFlow<RelayUiState> = _uiState

    fun connect() {
        _uiState.update { it.copy(connectionStatus = "Connecting", lastError = null) }
        relayClient.connect(_uiState.value.relayUrl, _uiState.value.activeAuthToken)
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
                approvals = emptyList(),
                gitSnapshots = emptyMap(),
                gitAudit = emptyMap(),
                lastConnectedAt = null,
                lastError = null
            )
        }
        connect()
    }

    fun saveRelaySettings(url: String, pairingToken: String) {
        val normalizedUrl = url.trim()
        if (!isValidRelayUrl(normalizedUrl)) {
            _uiState.update { it.copy(lastError = "Relay URL must start with ws:// or wss://") }
            return
        }

        val normalizedToken = pairingToken.trim()
        settings.saveRelayUrl(normalizedUrl)
        settings.savePairingToken(normalizedToken)
        settings.clearDevicePairing()
        settings.clearSessionCache()
        _uiState.update {
            it.copy(
                relayUrl = normalizedUrl,
                pairingToken = normalizedToken,
                deviceToken = "",
                deviceId = "",
                connectionStatus = "Disconnected",
                sessions = emptyList(),
                selectedSessionId = null,
                timeline = emptyList(),
                approvals = emptyList(),
                gitSnapshots = emptyMap(),
                gitAudit = emptyMap(),
                lastConnectedAt = null,
                lastHealthCheck = null,
                lastError = null
            )
        }
        connect()
    }

    fun testConnection() {
        _uiState.update { it.copy(lastError = null, lastHealthCheck = "Checking ${it.relayUrl}/health") }
        relayClient.testHealth(_uiState.value.relayUrl, _uiState.value.activeAuthToken)
    }

    fun pairDevice() {
        val state = _uiState.value
        _uiState.update { it.copy(lastError = null, lastHealthCheck = "Pairing device") }
        relayClient.pairDevice(state.relayUrl, state.pairingToken, state.deviceId)
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
        requestGitAudit()
    }

    fun sendPrompt(text: String) {
        val sessionId = _uiState.value.selectedSessionId ?: return
        if (text.isBlank()) {
            return
        }
        relayClient.sendPrompt(sessionId, text.trim())
    }

    fun requestGitStatus() {
        requestGit("status")
    }

    fun requestGitDiff() {
        requestGit("diff")
    }

    fun requestGitFileDiff(filePath: String) {
        if (filePath.isBlank()) {
            return
        }
        requestGit("diff", filePath)
    }

    fun requestGitCommit(message: String, commitStrategy: String) {
        if (message.isBlank()) {
            return
        }
        requestGit("commit", message = message.trim(), commitStrategy = commitStrategy)
    }

    fun requestGitPush() {
        requestGit("push")
    }

    fun requestGitAudit() {
        val sessionId = _uiState.value.selectedSessionId ?: return
        relayClient.requestGitAudit(
            _uiState.value.relayUrl,
            _uiState.value.activeAuthToken,
            sessionId
        )
    }

    fun decideApproval(approvalId: String, decision: String) {
        relayClient.sendApprovalDecision(approvalId, decision)
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

    override fun onApprovalRequest(approval: ApprovalItem) {
        _uiState.update { state ->
            val approvals = (listOf(approval) + state.approvals.filter { it.approvalId != approval.approvalId })
                .take(MAX_APPROVAL_ITEMS)
            state.copy(approvals = approvals)
        }
    }

    override fun onGitSnapshot(snapshot: GitSnapshot) {
        _uiState.update { state ->
            state.copy(gitSnapshots = state.gitSnapshots + (snapshot.sessionId to snapshot))
        }
        if (_uiState.value.selectedSessionId == snapshot.sessionId) {
            requestGitAudit()
        }
    }

    override fun onGitAudit(sessionId: String, events: List<GitAuditItem>) {
        _uiState.update { state ->
            state.copy(gitAudit = state.gitAudit + (sessionId to events))
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

    override fun onPairingComplete(deviceId: String, deviceToken: String) {
        settings.saveDevicePairing(deviceId, deviceToken)
        _uiState.update {
            it.copy(
                deviceId = deviceId,
                deviceToken = deviceToken,
                lastHealthCheck = "paired device: ${deviceId.take(8)}",
                lastError = null
            )
        }
        connect()
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
        const val MAX_APPROVAL_ITEMS = 50

        fun isValidRelayUrl(url: String): Boolean =
            url.startsWith("ws://") || url.startsWith("wss://")
    }

    private fun latestCursorFor(sessionId: String): String? = _uiState.value.timeline
        .filter { it.sessionId == sessionId }
        .mapNotNull { it.cursor?.toLongOrNull() }
        .maxOrNull()
        ?.toString()

    private fun requestGit(
        action: String,
        filePath: String? = null,
        message: String? = null,
        commitStrategy: String? = null
    ) {
        val sessionId = _uiState.value.selectedSessionId ?: return
        relayClient.requestGit(sessionId, action, filePath, message, commitStrategy)
    }
}
