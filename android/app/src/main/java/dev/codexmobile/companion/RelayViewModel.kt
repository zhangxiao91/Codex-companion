package dev.codexmobile.companion

import androidx.lifecycle.ViewModel
import java.time.Instant
import java.util.Base64
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.launch
import org.json.JSONObject

class RelayViewModel(
    private val settings: RelaySettings,
    private val cacheStore: RelayCacheStore
) : ViewModel(), RelayClient.Listener {
    private val relayClient = RelayClient(this)
    private val _uiState = MutableStateFlow(
        RelayUiState(
            relayUrl = settings.relayUrl(),
            pairingToken = settings.pairingToken(),
            deviceToken = settings.deviceToken(),
            deviceId = settings.deviceId(),
            sessions = cacheStore.sessions(),
            selectedSessionId = cacheStore.selectedSessionId(),
            pinnedSessionIds = cacheStore.pinnedSessionIds(),
            timeline = cacheStore.timeline(),
            promptQueues = cacheStore.promptQueues(),
            relayRequestState = cacheStore.relayRequestState(),
            relayRequestHistory = cacheStore.relayRequestHistory()
        )
    )
    val uiState: StateFlow<RelayUiState> = _uiState
    private var pendingNewChatHostId: String? = null
    private val confirmedSessionIds = mutableSetOf<String>()
    private val pendingTimelineSyncIds = mutableSetOf<String>()
    private var reconnectJob: Job? = null
    private var reconnectAttempt = 0

    fun connect() {
        reconnectJob?.cancel()
        _uiState.update {
            it.copy(
                connectionStatus = "Connecting",
                syncState = buildSyncState(active = true, summary = "Connecting and syncing sessions"),
                lastError = null
            )
        }
        relayClient.connect(_uiState.value.relayUrl, _uiState.value.activeAuthToken)
    }

    fun recoverConnectionIfNeeded() {
        val state = _uiState.value
        if (state.connectionStatus == "Online" || state.connectionStatus == "Connecting") {
            refreshAllSessions()
            return
        }
        if (state.deviceToken.isBlank()) {
            return
        }
        connect()
    }

    fun saveRelayUrl(url: String) {
        val normalizedUrl = url.trim()
        if (!isValidRelayUrl(normalizedUrl)) {
            _uiState.update { it.copy(lastError = "Relay URL must start with ws:// or wss://") }
            return
        }

        settings.saveRelayUrl(normalizedUrl)
        cacheStore.clearSessionCache()
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
                promptQueues = emptyMap(),
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
        cacheStore.clearSessionCache()
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
                promptQueues = emptyMap(),
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
        cacheStore.clearSessionCache()
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
                promptQueues = emptyMap(),
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
        cacheStore.saveSelectedSessionId(sessionId)
        if (sessionId in confirmedSessionIds) {
            relayClient.requestTimeline(sessionId, afterCursor)
            requestGitAudit()
        }
    }

    fun togglePinnedSession(sessionId: String) {
        _uiState.update { state ->
            val wasPinned = sessionId in state.pinnedSessionIds
            val pinned = if (sessionId in state.pinnedSessionIds) {
                state.pinnedSessionIds - sessionId
            } else {
                state.pinnedSessionIds + sessionId
            }
            cacheStore.savePinnedSessionIds(pinned)
            state.copy(
                pinnedSessionIds = pinned,
                lastHealthCheck = if (wasPinned) "Session unpinned" else "Session pinned",
                lastError = null
            )
        }
    }

    fun sendPrompt(text: String) {
        sendPrompt(PromptDraft(text = text.trim()))
    }

    fun sendPrompt(draft: PromptDraft) {
        val sessionId = _uiState.value.selectedSessionId
        if (sessionId == null) {
            _uiState.update { it.copy(lastError = "Select a session before sending a prompt") }
            return
        }
        if (sessionId !in confirmedSessionIds) {
            _uiState.update { it.copy(lastError = "Session is still syncing") }
            return
        }
        if (draft.text.isBlank() && draft.attachments.isEmpty()) {
            _uiState.update { it.copy(lastError = "Prompt cannot be empty") }
            return
        }
        if (draft.goalModeOnce && draft.goalObjective.isBlank()) {
            _uiState.update { it.copy(lastError = "Goal objective cannot be empty") }
            return
        }
        val sent = relayClient.sendPrompt(sessionId, draft.copy(text = draft.text.trim()))
        if (sent) {
            _uiState.update { it.copy(lastHealthCheck = "Prompt sent to Codex", lastError = null) }
        }
    }

    fun editPrompt(draft: PromptDraft) {
        val sessionId = _uiState.value.selectedSessionId
        if (sessionId == null) {
            _uiState.update { it.copy(lastError = "Select a session before editing a prompt") }
            return
        }
        if (sessionId !in confirmedSessionIds) {
            _uiState.update { it.copy(lastError = "Session is still syncing") }
            return
        }
        if (draft.editingBaseEventId.isNullOrBlank()) {
            _uiState.update { it.copy(lastError = "No editable prompt selected") }
            return
        }
        if (draft.text.isBlank() && draft.attachments.isEmpty()) {
            _uiState.update { it.copy(lastError = "Edited prompt cannot be empty") }
            return
        }
        if (draft.goalModeOnce && draft.goalObjective.isBlank()) {
            _uiState.update { it.copy(lastError = "Goal objective cannot be empty") }
            return
        }
        val sent = relayClient.editPrompt(sessionId, draft.copy(text = draft.text.trim()))
        if (sent) {
            _uiState.update { it.copy(lastHealthCheck = "Edited prompt sent to Codex", lastError = null) }
        }
    }

    fun queuePrompt(text: String) {
        val sessionId = _uiState.value.selectedSessionId
        if (sessionId == null) {
            _uiState.update { it.copy(lastError = "Select a session before queueing a prompt") }
            return
        }
        if (sessionId !in confirmedSessionIds) {
            _uiState.update { it.copy(lastError = "Session is still syncing") }
            return
        }
        val queue = _uiState.value.promptQueues[sessionId]
        if (queue != null && queue.depth >= queue.maxDepth) {
            _uiState.update { it.copy(lastError = "Prompt queue is full") }
            return
        }
        if (text.isBlank()) {
            _uiState.update { it.copy(lastError = "Queued prompt cannot be empty") }
            return
        }
        val sent = relayClient.queuePrompt(sessionId, text.trim())
        if (sent) {
            _uiState.update { it.copy(lastHealthCheck = "Prompt queued", lastError = null) }
        }
    }

    fun interruptTurn() {
        val sessionId = _uiState.value.selectedSessionId
        if (sessionId == null) {
            _uiState.update { it.copy(lastError = "Select a session before pausing Codex") }
            return
        }
        if (sessionId !in confirmedSessionIds) {
            _uiState.update { it.copy(lastError = "Session is still syncing") }
            return
        }
        val sent = relayClient.interruptTurn(sessionId)
        if (sent) {
            _uiState.update { it.copy(lastHealthCheck = "Pause requested", lastError = null) }
        }
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
        val sent = relayClient.createNewChat(hostId)
        if (sent) {
            _uiState.update { it.copy(lastError = null, lastHealthCheck = "Creating new chat on $hostId") }
        } else {
            pendingNewChatHostId = null
        }
    }

    fun loadEarlierTimeline() {
        val state = _uiState.value
        val sessionId = state.selectedSessionId ?: return
        if (sessionId !in confirmedSessionIds) {
            _uiState.update { it.copy(lastError = "Session is still syncing") }
            return
        }
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

        val sent = relayClient.requestTimeline(
            sessionId = sessionId,
            beforeCursor = beforeCursor,
            limit = TIMELINE_PAGE_SIZE,
            cacheOnly = false,
            page = true
        )
        if (sent) {
            _uiState.update { it.copy(timelineLoadingEarlier = true, lastError = null) }
        }
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

    fun requestPowerTrust() {
        val host = _uiState.value.selectedHost
        if (host == null) {
            _uiState.update { it.copy(lastError = "No online host is available for PC controls") }
            return
        }
        val sent = relayClient.requestPowerTrust(host.hostId)
        if (sent) {
            _uiState.update { it.copy(lastHealthCheck = "Requesting PC control verification", lastError = null) }
        }
    }

    fun verifyPowerTrust(code: String) {
        val challenge = _uiState.value.pendingPowerChallenge
        if (challenge == null) {
            _uiState.update { it.copy(lastError = "No pending PC control verification") }
            return
        }
        if (code.isBlank()) {
            _uiState.update { it.copy(lastError = "Verification code is required") }
            return
        }
        val sent = relayClient.verifyPowerTrust(challenge.hostId, challenge.challengeId, code.trim())
        if (sent) {
            _uiState.update { it.copy(lastHealthCheck = "Verifying PC control code", lastError = null) }
        }
    }

    fun requestKeepAwake(durationSeconds: Int) {
        requestPower("keep_awake", durationSeconds.coerceIn(60, 3600))
    }

    fun requestLockPc() {
        requestPower("lock", null)
    }

    fun requestGitAudit() {
        val sessionId = _uiState.value.selectedSessionId ?: return
        if (sessionId !in confirmedSessionIds) {
            return
        }
        relayClient.requestGitAudit(
            _uiState.value.relayUrl,
            _uiState.value.activeAuthToken,
            sessionId
        )
    }

    fun decideApproval(approvalId: String, decision: String) {
        val sent = relayClient.sendApprovalDecision(approvalId, decision)
        if (sent) {
            _uiState.update { it.copy(lastHealthCheck = "Approval decision sent", lastError = null) }
        }
    }

    override fun onConnected() {
        reconnectJob?.cancel()
        reconnectAttempt = 0
        confirmedSessionIds.clear()
        pendingTimelineSyncIds.clear()
        _uiState.update {
            it.copy(
                connectionStatus = "Online",
                lastConnectedAt = Instant.now().toString(),
                approvals = emptyList(),
                syncState = buildSyncState(
                    active = it.sessions.isNotEmpty(),
                    summary = if (it.sessions.isEmpty()) "" else "Relay connected, syncing sessions"
                ),
                lastError = null
            )
        }
    }

    override fun onDisconnected(reason: String) {
        _uiState.update {
            it.copy(
                connectionStatus = "Disconnected",
                syncState = buildSyncState(active = false),
                lastError = reason.ifBlank { "Relay disconnected" }
            )
        }
        scheduleReconnect(reason)
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
        val isNewlyConfirmed = confirmedSessionIds.add(session.sessionId)
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
        cacheStore.saveSessions(state.sessions)
        cacheStore.saveSelectedSessionId(state.selectedSessionId)
        updateSyncState()
        if (isNewlyConfirmed) {
            syncSession(session.sessionId)
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

    override fun onPowerStatus(status: PowerStatus) {
        _uiState.update { state ->
            state.copy(powerStatuses = state.powerStatuses + (status.hostId to status))
        }
    }

    override fun onPowerTrustChallenge(challenge: PowerTrustChallenge) {
        if (challenge.deviceId.isNotBlank() && challenge.deviceId != _uiState.value.deviceId) {
            return
        }
        _uiState.update {
            it.copy(
                pendingPowerChallenge = challenge,
                lastHealthCheck = "Enter the code shown on your computer",
                lastError = null
            )
        }
    }

    override fun onPowerTrustGranted(trust: PowerTrust) {
        if (trust.deviceId.isNotBlank() && trust.deviceId != _uiState.value.deviceId) {
            return
        }
        _uiState.update { state ->
            state.copy(
                powerTrusts = state.powerTrusts + (trust.hostId to trust),
                pendingPowerChallenge = null,
                lastHealthCheck = "PC controls enabled",
                lastError = null
            )
        }
    }

    override fun onPowerResult(result: PowerResult) {
        if (result.deviceId.isNotBlank() && result.deviceId != _uiState.value.deviceId) {
            return
        }
        _uiState.update {
            it.copy(
                lastPowerResult = result,
                lastHealthCheck = "${result.action}: ${result.status}",
                lastError = if (result.status == "accepted") null else result.reason.ifBlank { "Power request rejected" }
            )
        }
    }

    override fun onTimelineEvent(event: TimelineItem) {
        pendingTimelineSyncIds.remove(event.sessionId)
        _uiState.update { state ->
            val timeline = mergeTimelineEvents(state.timeline, listOf(event))
            state.copy(
                timeline = timeline,
                promptQueues = updatePromptQueueState(state.promptQueues, event)
            )
        }
        persistCachedState()
        updateSyncState()
    }

    override fun onTimelinePage(sessionId: String, events: List<TimelineItem>, hasMoreBefore: Boolean, source: String) {
        pendingTimelineSyncIds.remove(sessionId)
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
        persistCachedState()
    }

    override fun onNotificationEvent(notification: NotificationEvent) {
        _uiState.update { state ->
            val notifications = (listOf(notification) + state.notifications.filter { it.notificationId != notification.notificationId })
                .take(MAX_NOTIFICATION_ITEMS)
            state.copy(notifications = notifications)
        }
    }

    override fun onRelayRequestState(state: RelayRequestState) {
        cacheStore.saveRelayRequestState(state)
        _uiState.update { current ->
            val history = (listOf(state) + current.relayRequestHistory.filterNot { sameRelayRequest(it, state) })
                .sortedByDescending { parseIsoMillis(it.updatedAt.orEmpty()) }
                .take(20)
            current.copy(relayRequestState = state, relayRequestHistory = history)
        }
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
        _uiState.update { it.copy(timelineLoadingEarlier = false, syncState = buildSyncState(active = false), lastError = message) }
    }

    fun refreshAllSessions() {
        syncAllKnownSessions()
    }

    override fun onCleared() {
        reconnectJob?.cancel()
        relayClient.close()
        super.onCleared()
    }

    private companion object {
        const val MAX_TIMELINE_ITEMS_PER_SESSION = 10000
        const val MAX_APPROVAL_ITEMS = 50
        const val MAX_NOTIFICATION_ITEMS = 200
        const val TIMELINE_PAGE_SIZE = 80
        const val MAX_RECONNECT_DELAY_MS = 30_000L

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

    private fun syncSession(sessionId: String) {
        if (sessionId !in confirmedSessionIds) {
            return
        }
        if (sessionId in pendingTimelineSyncIds) {
            return
        }
        val latestCursor = latestCursorFor(sessionId) ?: cacheStore.syncState(sessionId)?.latestCursor
        pendingTimelineSyncIds.add(sessionId)
        updateSyncState()
        val sent = relayClient.requestTimeline(sessionId, latestCursor)
        if (!sent) {
            pendingTimelineSyncIds.remove(sessionId)
            updateSyncState()
        }
    }

    private fun syncAllKnownSessions() {
        val confirmed = confirmedSessionIds.toSet()
        _uiState.value.sessions
            .filter { it.sessionId in confirmed }
            .forEach { session ->
                syncSession(session.sessionId)
        }
        updateSyncState()
    }

    private fun scheduleReconnect(reason: String) {
        val state = _uiState.value
        if (state.deviceToken.isBlank()) {
            return
        }
        if (state.relayUrl.isBlank()) {
            return
        }
        if (reason.equals("closing", ignoreCase = true)) {
            return
        }
        if (reconnectJob?.isActive == true) {
            return
        }

        val delayMs = reconnectDelayMs()
        reconnectJob = viewModelScope.launch {
            delay(delayMs)
            val current = _uiState.value
            if (current.connectionStatus == "Online" || current.connectionStatus == "Connecting" || current.deviceToken.isBlank()) {
                return@launch
            }
            _uiState.update {
                it.copy(
                    connectionStatus = "Connecting",
                    syncState = buildSyncState(active = true, summary = "Reconnecting to Relay"),
                    lastHealthCheck = "Reconnecting to Relay",
                    lastError = null
                )
            }
            relayClient.connect(current.relayUrl, current.activeAuthToken)
        }
    }

    private fun reconnectDelayMs(): Long {
        reconnectAttempt += 1
        return when (reconnectAttempt) {
            1 -> 1_000L
            2 -> 2_000L
            3 -> 5_000L
            else -> MAX_RECONNECT_DELAY_MS
        }
    }

    private fun persistCachedState() {
        val state = _uiState.value
        cacheStore.saveTimeline(state.timeline)
        cacheStore.savePromptQueues(state.promptQueues)
        state.timeline.map { it.sessionId }.distinct().forEach { sessionId ->
            val sessionTimeline = state.timeline.filter { it.sessionId == sessionId }
            val latest = sessionTimeline.mapNotNull { it.cursor?.toLongOrNull() }.maxOrNull()?.toString()
            val earliest = sessionTimeline.mapNotNull { it.cursor?.toLongOrNull() }.minOrNull()?.toString()
            cacheStore.saveSyncState(sessionId, latest, earliest)
        }
    }

    private fun updateSyncState() {
        _uiState.update { state ->
            val pendingSessions = state.sessions.count { it.sessionId !in confirmedSessionIds }
            val pendingTimeline = pendingTimelineSyncIds.size
            val active = state.connectionStatus == "Connecting" || pendingSessions > 0 || pendingTimeline > 0 || state.timelineLoadingEarlier
            state.copy(
                syncState = buildSyncState(
                    active = active,
                    summary = when {
                        state.connectionStatus == "Connecting" -> "Connecting and syncing sessions"
                        pendingSessions > 0 -> "Confirming ${pendingSessions} session${if (pendingSessions == 1) "" else "s"}"
                        pendingTimeline > 0 -> "Syncing timeline for ${pendingTimeline} session${if (pendingTimeline == 1) "" else "s"}"
                        state.timelineLoadingEarlier -> "Loading earlier history"
                        else -> ""
                    },
                    pendingSessionCount = pendingSessions + pendingTimeline,
                    totalSessionCount = state.sessions.size
                )
            )
        }
    }

    private fun buildSyncState(
        active: Boolean,
        summary: String = "",
        pendingSessionCount: Int = _uiState.value.sessions.count { it.sessionId !in confirmedSessionIds } + pendingTimelineSyncIds.size,
        totalSessionCount: Int = _uiState.value.sessions.size
    ): SyncState = SyncState(
        active = active,
        pendingSessionCount = pendingSessionCount,
        confirmedSessionCount = confirmedSessionIds.size,
        totalSessionCount = totalSessionCount,
        summary = summary
    )

    private fun mergeTimelineEvents(current: List<TimelineItem>, incoming: List<TimelineItem>): List<TimelineItem> {
        if (incoming.isEmpty()) {
            return current
        }

        val incomingIds = incoming.map { it.eventId }.toSet()
        return (incoming + current.filter { it.eventId !in incomingIds })
            .sortedWith(compareByDescending<TimelineItem> { it.cursor?.toLongOrNull() ?: Long.MIN_VALUE }
            .thenByDescending { it.createdAt })
            .groupBy { it.sessionId }
            .values
            .flatMap { it.take(MAX_TIMELINE_ITEMS_PER_SESSION) }
            .sortedWith(compareByDescending<TimelineItem> { it.cursor?.toLongOrNull() ?: Long.MIN_VALUE }
            .thenByDescending { it.createdAt })
    }

    private fun updatePromptQueueState(current: Map<String, PromptQueueState>, event: TimelineItem): Map<String, PromptQueueState> {
        val queueState = current[event.sessionId]
        return when (event.type) {
            "prompt_queued" -> {
                val depth = event.summary
                    .substringAfter("Queued prompt ")
                    .substringBefore("/")
                    .toIntOrNull()
                    ?: queueState?.depth
                    ?: 1
                val maxDepth = event.summary
                    .substringAfter("/")
                    .substringBefore(".")
                    .toIntOrNull()
                    ?: queueState?.maxDepth
                    ?: 5
                current + (event.sessionId to PromptQueueState(event.sessionId, depth, maxDepth))
            }
            "prompt_queue_started" -> {
                val depth = event.summary
                    .substringAfter("Started queued prompt. ")
                    .substringBefore("/")
                    .toIntOrNull()
                    ?: ((queueState?.depth ?: 1) - 1).coerceAtLeast(0)
                val maxDepth = event.summary
                    .substringAfter("/")
                    .substringBefore(" queued")
                    .toIntOrNull()
                    ?: queueState?.maxDepth
                    ?: 5
                if (depth <= 0) {
                    current - event.sessionId
                } else {
                    current + (event.sessionId to PromptQueueState(event.sessionId, depth, maxDepth))
                }
            }
            else -> current
        }
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
        if (sessionId !in confirmedSessionIds) {
            _uiState.update { it.copy(lastError = "Session is still syncing") }
            return
        }
        val sent = relayClient.requestGit(sessionId, action, filePath, message, commitStrategy)
        if (sent) {
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
        }
    }

    private fun requestPower(action: String, durationSeconds: Int?) {
        val state = _uiState.value
        val host = state.selectedHost
        if (host == null) {
            _uiState.update { it.copy(lastError = "No host is available for PC controls") }
            return
        }
        val capability = if (action == "lock") "power.lock" else "power.keep_awake"
        val trust = state.powerTrusts[host.hostId]
        if (trust == null || capability !in trust.capabilities) {
            _uiState.update { it.copy(lastError = "Enable PC controls before using ${action.replace('_', ' ')}") }
            return
        }
        val sent = relayClient.requestPower(host.hostId, action, durationSeconds)
        if (sent) {
            _uiState.update { it.copy(lastHealthCheck = "Sending ${action.replace('_', ' ')} request", lastError = null) }
        }
    }

    private fun parseIsoMillis(raw: String): Long =
        runCatching { Instant.parse(raw).toEpochMilli() }.getOrDefault(0L)

    private fun sameRelayRequest(left: RelayRequestState, right: RelayRequestState): Boolean {
        val leftKey = left.messageId ?: "${left.type}:${left.updatedAt.orEmpty()}"
        val rightKey = right.messageId ?: "${right.type}:${right.updatedAt.orEmpty()}"
        return leftKey == rightKey
    }
}
