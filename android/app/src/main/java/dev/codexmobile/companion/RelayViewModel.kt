package dev.codexmobile.companion

import androidx.lifecycle.ViewModel
import java.time.Instant
import java.util.Base64
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import org.json.JSONObject

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
            pinnedSessionIds = settings.pinnedSessionIds(),
            timeline = settings.timeline()
        )
    )
    val uiState: StateFlow<RelayUiState> = _uiState
    private var pendingNewChatHostId: String? = null

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
                hosts = emptyList(),
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
                hosts = emptyList(),
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

    fun applyPairingCode(pairingCode: String) {
        val parsed = parsePairingCode(pairingCode)
        if (parsed == null) {
            _uiState.update { it.copy(lastError = "Invalid pairing code") }
            return
        }

        val (relayUrl, pairingToken) = parsed
        if (!isValidRelayUrl(relayUrl)) {
            _uiState.update { it.copy(lastError = "Pairing code Relay URL must start with ws:// or wss://") }
            return
        }

        settings.saveRelayUrl(relayUrl)
        settings.savePairingToken(pairingToken)
        settings.clearDevicePairing()
        settings.clearSessionCache()
        _uiState.update {
            it.copy(
                relayUrl = relayUrl,
                pairingToken = pairingToken,
                deviceToken = "",
                deviceId = "",
                connectionStatus = "Disconnected",
                sessions = emptyList(),
                hosts = emptyList(),
                selectedSessionId = null,
                timeline = emptyList(),
                approvals = emptyList(),
                gitSnapshots = emptyMap(),
                gitAudit = emptyMap(),
                lastConnectedAt = null,
                lastHealthCheck = "Pairing from code",
                lastError = null
            )
        }
        relayClient.pairDevice(relayUrl, pairingToken, _uiState.value.deviceId)
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

    fun togglePinnedSession(sessionId: String) {
        _uiState.update { state ->
            val wasPinned = sessionId in state.pinnedSessionIds
            val pinned = if (sessionId in state.pinnedSessionIds) {
                state.pinnedSessionIds - sessionId
            } else {
                state.pinnedSessionIds + sessionId
            }
            settings.savePinnedSessionIds(pinned)
            state.copy(
                pinnedSessionIds = pinned,
                lastHealthCheck = if (wasPinned) "Session unpinned" else "Session pinned",
                lastError = null
            )
        }
    }

    fun sendPrompt(text: String) {
        val sessionId = _uiState.value.selectedSessionId
        if (sessionId == null) {
            _uiState.update { it.copy(lastError = "Select a session before sending a prompt") }
            return
        }
        if (text.isBlank()) {
            _uiState.update { it.copy(lastError = "Prompt cannot be empty") }
            return
        }
        _uiState.update { it.copy(lastHealthCheck = "Prompt sent to Codex", lastError = null) }
        relayClient.sendPrompt(sessionId, text.trim())
    }

    fun createNewChat() {
        val state = _uiState.value
        if (state.connectionStatus != "Online") {
            _uiState.update { it.copy(lastError = "Connect to Relay before starting a new chat") }
            return
        }

        val hostId = state.selectedSession?.hostId
            ?: state.sessions.firstOrNull()?.hostId
        if (hostId.isNullOrBlank()) {
            _uiState.update { it.copy(lastError = "No online host is available for New Chat") }
            return
        }

        pendingNewChatHostId = hostId
        _uiState.update { it.copy(lastError = null, lastHealthCheck = "Creating new chat on $hostId") }
        relayClient.createNewChat(hostId)
    }

    fun loadEarlierTimeline() {
        val state = _uiState.value
        val sessionId = state.selectedSessionId ?: return
        if (state.timelineLoadingEarlier) {
            return
        }
        if (state.timelineHasMoreEarlier[sessionId] == false) {
            return
        }

        val beforeCursor = earliestCursorFor(sessionId)
        if (beforeCursor == null) {
            _uiState.update { it.copy(lastError = "No cached timeline cursor yet.") }
            return
        }

        _uiState.update { it.copy(timelineLoadingEarlier = true, lastError = null) }
        relayClient.requestTimeline(
            sessionId = sessionId,
            beforeCursor = beforeCursor,
            limit = TIMELINE_PAGE_SIZE,
            cacheOnly = false,
            page = true
        )
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
        _uiState.update { it.copy(lastHealthCheck = "Approval decision sent", lastError = null) }
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

    override fun onHostSnapshot(host: HostNode) {
        _uiState.update { state ->
            val hosts = (listOf(host) + state.hosts.filter { it.hostId != host.hostId })
                .sortedWith(compareByDescending<HostNode> { it.status == "online" }
                    .thenByDescending { parseIsoMillis(it.lastSeenAt) }
                    .thenBy { it.displayName.lowercase() })
            state.copy(hosts = hosts)
        }
    }

    override fun onSessionSnapshot(session: CodexSession) {
        val shouldSelectNewChat = pendingNewChatHostId == session.hostId
        _uiState.update { state ->
            val sessions = listOf(session) + state.sessions.filter { it.sessionId != session.sessionId }
            val selectedSessionId = if (shouldSelectNewChat) {
                session.sessionId
            } else {
                state.selectedSessionId ?: session.sessionId
            }
            state.copy(sessions = sessions, selectedSessionId = selectedSessionId)
        }
        if (shouldSelectNewChat) {
            pendingNewChatHostId = null
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
            val timeline = mergeTimelineEvents(state.timeline, listOf(event))
            state.copy(timeline = timeline)
        }
        settings.saveTimeline(_uiState.value.timeline)
    }

    override fun onTimelinePage(sessionId: String, events: List<TimelineItem>, hasMoreBefore: Boolean, source: String) {
        _uiState.update { state ->
            val timeline = mergeTimelineEvents(state.timeline, events)
            val waitingForHostPage = source == "cache" && state.timelineLoadingEarlier
            val nextHasMoreEarlier = if (waitingForHostPage) {
                state.timelineHasMoreEarlier
            } else {
                state.timelineHasMoreEarlier + (sessionId to hasMoreBefore)
            }
            state.copy(
                timeline = timeline,
                timelineLoadingEarlier = waitingForHostPage,
                timelineHasMoreEarlier = nextHasMoreEarlier,
                lastHealthCheck = if (events.isEmpty()) "No earlier timeline events cached" else "Loaded ${events.size} earlier timeline event(s)",
                lastError = null
            )
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
        _uiState.update { it.copy(timelineLoadingEarlier = false, lastError = message) }
    }

    override fun onCleared() {
        relayClient.close()
        super.onCleared()
    }

    private companion object {
        const val MAX_TIMELINE_ITEMS = 2000
        const val MAX_APPROVAL_ITEMS = 50
        const val TIMELINE_PAGE_SIZE = 80

        fun isValidRelayUrl(url: String): Boolean =
            url.startsWith("ws://") || url.startsWith("wss://")

        fun parsePairingCode(raw: String): Pair<String, String>? {
            val code = raw.trim()
            if (!code.startsWith("cmc1.")) {
                return null
            }

            return runCatching {
                val encoded = code.removePrefix("cmc1.")
                val json = JSONObject(String(Base64.getUrlDecoder().decode(encoded), Charsets.UTF_8))
                val relayUrl = json.optString("relay_url", "").trim()
                val pairingToken = json.optString("pairing_token", "").trim()
                if (relayUrl.isBlank() || pairingToken.isBlank()) {
                    null
                } else {
                    relayUrl to pairingToken
                }
            }.getOrNull()
        }
    }

    private fun latestCursorFor(sessionId: String): String? = _uiState.value.timeline
        .filter { it.sessionId == sessionId }
        .mapNotNull { it.cursor?.toLongOrNull() }
        .maxOrNull()
        ?.toString()

    private fun earliestCursorFor(sessionId: String): String? = _uiState.value.timeline
        .filter { it.sessionId == sessionId }
        .mapNotNull { it.cursor?.toLongOrNull() }
        .minOrNull()
        ?.toString()

    private fun mergeTimelineEvents(current: List<TimelineItem>, incoming: List<TimelineItem>): List<TimelineItem> {
        if (incoming.isEmpty()) {
            return current
        }

        val incomingIds = incoming.map { it.eventId }.toSet()
        return (incoming + current.filter { it.eventId !in incomingIds })
            .sortedWith(compareByDescending<TimelineItem> { it.cursor?.toLongOrNull() ?: Long.MIN_VALUE }
                .thenByDescending { it.createdAt })
            .take(MAX_TIMELINE_ITEMS)
    }

    private fun requestGit(
        action: String,
        filePath: String? = null,
        message: String? = null,
        commitStrategy: String? = null
    ) {
        val sessionId = _uiState.value.selectedSessionId
        if (sessionId == null) {
            _uiState.update { it.copy(lastError = "Select a session before using Git tools") }
            return
        }
        _uiState.update {
            it.copy(
                lastHealthCheck = when (action) {
                    "status" -> "Requesting Git status"
                    "diff" -> if (filePath.isNullOrBlank()) "Requesting Git diff" else "Requesting file diff"
                    "commit" -> "Sending commit request"
                    "push" -> "Sending push request"
                    else -> "Sending Git request"
                },
                lastError = null
            )
        }
        relayClient.requestGit(sessionId, action, filePath, message, commitStrategy)
    }

    private fun parseIsoMillis(raw: String): Long =
        runCatching { Instant.parse(raw).toEpochMilli() }.getOrDefault(0L)
}
