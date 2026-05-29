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
    private val initialSessions = cacheStore.sessions()
    private val initialApprovals = cacheStore.approvals()
    private val confirmedSessionIds = cacheStore.confirmedSessionIds()
        .plus(initialSessions.map { it.sessionId })
        .toMutableSet()
    private val pendingTimelineSyncIds = cacheStore.pendingTimelineSyncIds().toMutableSet()
    private val timelineSyncInFlightIds = mutableSetOf<String>()
    private val timelineSyncQueueIds = ArrayDeque<String>()
    private val timelineSyncTimeoutJobs = mutableMapOf<String, Job>()
    private var earlierTimelineTimeoutJob: Job? = null
    private val snapshotSyncedSessionIds = mutableSetOf<String>()
    private var syncIndexMode: SyncIndexMode = SyncIndexMode.Incremental
    private var prioritySyncIndexRequested = false
    private val _uiState = MutableStateFlow(
        RelayUiState(
            relayUrl = settings.relayUrl(),
            pairingToken = settings.pairingToken(),
            deviceToken = settings.deviceToken(),
            deviceId = settings.deviceId(),
            sessions = initialSessions,
            selectedSessionId = cacheStore.selectedSessionId(),
            pinnedSessionIds = cacheStore.pinnedSessionIds(),
            archivedSessionIds = cacheStore.archivedSessionIds(),
            timeline = cacheStore.timeline(),
            approvals = initialApprovals,
            promptQueues = cacheStore.promptQueues(),
            cloudSyncStates = cacheStore.cloudSyncStates(),
            relayRequestState = cacheStore.relayRequestState(),
            relayRequestHistory = cacheStore.relayRequestHistory(),
            pendingApprovalIds = RelayStateReducers.pendingApprovalIds(initialApprovals),
            confirmedSessionIds = confirmedSessionIds.toSet(),
            pendingTimelineSyncIds = pendingTimelineSyncIds.toSet()
        )
    )
    val uiState: StateFlow<RelayUiState> = _uiState
    private var pendingNewChatRequestId: String? = null
    private var reconnectJob: Job? = null
    private var reconnectAttempt = 0
    private var lastForegroundRefreshAtMillis = 0L

    fun connect(preservePendingAcks: Boolean = false) {
        reconnectJob?.cancel()
        prioritySyncIndexRequested = false
        syncIndexMode = SyncIndexMode.Incremental
        _uiState.update {
            it.copy(
                connectionStatus = "Connecting",
                syncState = buildSyncState(active = true, summary = "Connecting and syncing sessions"),
                lastError = null
            )
        }
        relayClient.connect(
            _uiState.value.relayUrl,
            _uiState.value.activeAuthToken,
            preservePendingAcks = preservePendingAcks
        )
    }

    fun recoverConnectionIfNeeded() {
        val state = _uiState.value
        if (state.connectionStatus == "Online" || state.connectionStatus == "Connecting") {
            if (state.connectionStatus == "Online" && shouldRunForegroundRefresh()) {
                refreshAllSessions()
            }
            return
        }
        if (state.deviceToken.isBlank()) {
            return
        }
        connect(preservePendingAcks = true)
    }

    fun saveRelayUrl(url: String) {
        val normalizedUrl = url.trim()
        if (!isValidRelayUrl(normalizedUrl)) {
            _uiState.update { it.copy(lastError = "Relay URL must start with ws:// or wss://") }
            return
        }

        settings.saveRelayUrl(normalizedUrl)
        cacheStore.clearSessionCache()
        resetSessionSyncMarkers()
        _uiState.update {
            it.copy(
                relayUrl = normalizedUrl,
                connectionStatus = "Disconnected",
                sessions = emptyList(),
                hosts = emptyList(),
                selectedSessionId = null,
                archivedSessionIds = emptySet(),
                timeline = emptyList(),
                approvals = emptyList(),
                gitSnapshots = emptyMap(),
                gitAudit = emptyMap(),
                promptQueues = emptyMap(),
                lastConnectedAt = null,
                connectionDiagnostics = null,
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
        resetSessionSyncMarkers()
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
                archivedSessionIds = emptySet(),
                timeline = emptyList(),
                approvals = emptyList(),
                gitSnapshots = emptyMap(),
                gitAudit = emptyMap(),
                promptQueues = emptyMap(),
                lastConnectedAt = null,
                connectionDiagnostics = null,
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
        resetSessionSyncMarkers()
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
                archivedSessionIds = emptySet(),
                timeline = emptyList(),
                approvals = emptyList(),
                gitSnapshots = emptyMap(),
                gitAudit = emptyMap(),
                promptQueues = emptyMap(),
                lastConnectedAt = null,
                connectionDiagnostics = null,
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
        _uiState.update { it.copy(selectedSessionId = sessionId) }
        cacheStore.saveSelectedSessionId(sessionId)
        if (sessionId in confirmedSessionIds) {
            refreshLatestTimeline(sessionId)
            requestGitAudit()
        }
    }

    fun refreshSelectedTimeline() {
        val sessionId = _uiState.value.selectedSessionId ?: return
        if (sessionId !in confirmedSessionIds) {
            _uiState.update { it.copy(lastError = "Session is still syncing") }
            return
        }
        refreshLatestTimeline(sessionId)
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
            if (state.deviceToken.isNotBlank()) {
                relayClient.updateSessionPin(sessionId, !wasPinned)
            }
            state.copy(
                pinnedSessionIds = pinned,
                lastHealthCheck = if (wasPinned) "Session unpinned" else "Session pinned",
                lastError = null
            )
        }
    }

    fun archiveSession(sessionId: String) {
        _uiState.update { state ->
            val archived = state.archivedSessionIds + sessionId
            val pinned = state.pinnedSessionIds - sessionId
            val nextSelectedSessionId = if (state.selectedSessionId == sessionId) {
                state.sessions
                    .filterNot { it.sessionId in archived }
                    .maxByOrNull { parseIsoMillis(it.updatedAt) }
                    ?.sessionId
            } else {
                state.selectedSessionId
            }
            cacheStore.saveArchivedSessionIds(archived)
            cacheStore.savePinnedSessionIds(pinned)
            cacheStore.saveSelectedSessionId(nextSelectedSessionId)
            if (state.deviceToken.isNotBlank()) {
                relayClient.updateSessionArchive(sessionId, true)
                if (sessionId in state.pinnedSessionIds) {
                    relayClient.updateSessionPin(sessionId, false)
                }
            }
            state.copy(
                archivedSessionIds = archived,
                pinnedSessionIds = pinned,
                selectedSessionId = nextSelectedSessionId,
                lastHealthCheck = "Session archived",
                lastError = null
            )
        }
    }

    fun restoreArchivedSession(sessionId: String) {
        _uiState.update { state ->
            val archived = state.archivedSessionIds - sessionId
            cacheStore.saveArchivedSessionIds(archived)
            if (state.deviceToken.isNotBlank()) {
                relayClient.updateSessionArchive(sessionId, false)
                requestSessionSyncIndex(
                    includeClean = true,
                    includeArchived = true,
                    mode = SyncIndexMode.ArchiveConfirm,
                    sessionIds = listOf(sessionId)
                )
            }
            state.copy(
                archivedSessionIds = archived,
                lastHealthCheck = "Session restored",
                lastError = null
            )
        }
    }

    fun restoreAllArchivedSessions() {
        val sessionIds = _uiState.value.archivedSessionIds.toList()
        if (sessionIds.isEmpty()) {
            return
        }
        _uiState.update { state ->
            cacheStore.saveArchivedSessionIds(emptySet())
            if (state.deviceToken.isNotBlank()) {
                sessionIds.forEach { sessionId -> relayClient.updateSessionArchive(sessionId, false) }
                requestSessionSyncIndex(
                    includeClean = true,
                    includeArchived = true,
                    mode = SyncIndexMode.ArchiveConfirm,
                    sessionIds = sessionIds
                )
            }
            state.copy(
                archivedSessionIds = emptySet(),
                lastHealthCheck = "Restored ${sessionIds.size} archived session(s)",
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

        val requestId = java.util.UUID.randomUUID().toString()
        pendingNewChatRequestId = requestId
        val sent = relayClient.createNewChat(hostId, requestId)
        if (sent) {
            _uiState.update { it.copy(lastError = null, lastHealthCheck = "Creating new chat on $hostId") }
        } else {
            pendingNewChatRequestId = null
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
            scheduleEarlierTimelineTimeout(sessionId)
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
            _uiState.update { state ->
                val approvals = state.approvals.filter { it.approvalId != approvalId }
                cacheStore.saveApprovals(approvals)
                state.copy(
                    approvals = approvals,
                    pendingApprovalIds = RelayStateReducers.pendingApprovalIds(approvals),
                    lastHealthCheck = "Approval decision sent",
                    lastError = null
                )
            }
        }
    }

    override fun onConnected() {
        reconnectJob?.cancel()
        reconnectAttempt = 0
        confirmedSessionIds.addAll(_uiState.value.sessions.map { it.sessionId })
        pendingTimelineSyncIds.clear()
        timelineSyncInFlightIds.clear()
        snapshotSyncedSessionIds.clear()
        cacheStore.saveApprovals(emptyList())
        persistSessionSyncMarkers()
        _uiState.update {
            it.copy(
                connectionStatus = "Online",
                lastConnectedAt = Instant.now().toString(),
                syncState = buildSyncState(
                    active = it.sessions.isNotEmpty(),
                    summary = if (it.sessions.isEmpty()) "" else "Relay connected, syncing priority sessions"
                ),
                confirmedSessionIds = confirmedSessionIds.toSet(),
                pendingTimelineSyncIds = pendingTimelineSyncIds.toSet(),
                approvals = emptyList(),
                pendingApprovalIds = emptySet(),
                lastError = null
            )
        }
        requestSessionSyncIndex()
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

    override fun onSessionSnapshot(session: CodexSession, clientRequestId: String?) {
        val isNewlyConfirmed = confirmedSessionIds.add(session.sessionId)
        if (isNewlyConfirmed) {
            persistSessionSyncMarkers()
        }
        val shouldSelectNewChat = !clientRequestId.isNullOrBlank() && clientRequestId == pendingNewChatRequestId
        _uiState.update { state ->
            val sessions = listOf(session) + state.sessions.filter { it.sessionId != session.sessionId }
            val selectedSessionId = if (shouldSelectNewChat) {
                session.sessionId
            } else {
                state.selectedSessionId ?: session.sessionId
            }
            val archivedSessionIds = if (shouldSelectNewChat) {
                state.archivedSessionIds - session.sessionId
            } else {
                state.archivedSessionIds
            }
            if (shouldSelectNewChat) {
                cacheStore.saveArchivedSessionIds(archivedSessionIds)
                if (state.deviceToken.isNotBlank()) {
                    relayClient.updateSessionArchive(session.sessionId, false)
                }
            }
            state.copy(
                sessions = sessions,
                selectedSessionId = selectedSessionId,
                archivedSessionIds = archivedSessionIds,
                confirmedSessionIds = confirmedSessionIds.toSet(),
                pendingTimelineSyncIds = pendingTimelineSyncIds.toSet()
            )
        }
        if (shouldSelectNewChat) {
            pendingNewChatRequestId = null
        }
        val state = _uiState.value
        cacheStore.saveSessions(state.sessions)
        cacheStore.saveSelectedSessionId(state.selectedSessionId)
        updateSyncState()
        if (!state.syncIndexSupported && snapshotSyncedSessionIds.add(session.sessionId) && shouldAutoSyncSession(session)) {
            syncSession(session.sessionId)
        }
    }

    override fun onApprovalRequest(approval: ApprovalItem) {
        _uiState.update { state ->
            val approvals = RelayStateReducers.mergeApproval(state.approvals, approval, MAX_APPROVAL_ITEMS)
            cacheStore.saveApprovals(approvals)
            state.copy(
                approvals = approvals,
                pendingApprovalIds = RelayStateReducers.pendingApprovalIds(approvals)
            )
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
        timelineSyncInFlightIds.remove(event.sessionId)
        cancelTimelineSyncTimeout(event.sessionId)
        persistSessionSyncMarkers()
        _uiState.update { state ->
            val timeline = mergeTimelineEvents(state.timeline, listOf(event))
            state.copy(
                timeline = timeline,
                promptQueues = RelayStateReducers.updatePromptQueueState(state.promptQueues, event),
                pendingTimelineSyncIds = pendingTimelineSyncIds.toSet()
            )
        }
        persistCachedState()
        updateSyncState()
        ackCloudSyncIfCaughtUp(event.sessionId)
        drainTimelineSyncQueue()
    }

    override fun onTimelinePage(sessionId: String, events: List<TimelineItem>, hasMoreBefore: Boolean, source: String) {
        val backgroundCachePrelude = source == "cache"
            && sessionId in timelineSyncInFlightIds
            && !_uiState.value.timelineLoadingEarlier
        if (!backgroundCachePrelude) {
            pendingTimelineSyncIds.remove(sessionId)
            timelineSyncInFlightIds.remove(sessionId)
            cancelTimelineSyncTimeout(sessionId)
            persistSessionSyncMarkers()
        }
        _uiState.update { state ->
            val timeline = mergeTimelineEvents(state.timeline, events)
            val waitingForHostPage = source == "cache" && state.timelineLoadingEarlier
            val nextHasMoreEarlier = if (waitingForHostPage) {
                state.timelineHasMoreEarlier
            } else {
                state.timelineHasMoreEarlier + (sessionId to hasMoreBefore)
            }
            if (!waitingForHostPage) {
                cancelEarlierTimelineTimeout()
            }
            state.copy(
                timeline = timeline,
                timelineLoadingEarlier = waitingForHostPage,
                timelineHasMoreEarlier = nextHasMoreEarlier,
                pendingTimelineSyncIds = pendingTimelineSyncIds.toSet(),
                lastHealthCheck = when {
                    backgroundCachePrelude -> "Loaded cached timeline; waiting for host"
                    source == "host_error" -> "Timeline sync failed"
                    events.isEmpty() -> "No earlier timeline events cached"
                    else -> "Loaded ${events.size} earlier timeline event(s)"
                },
                lastError = if (source == "host_error") "Host timeline sync failed for $sessionId" else null
            )
        }
        persistCachedState()
        updateSyncState()
        if (!backgroundCachePrelude) {
            ackCloudSyncIfCaughtUp(sessionId)
        }
        if (!backgroundCachePrelude) {
            drainTimelineSyncQueue()
        }
    }

    override fun onSessionSyncIndex(
        entries: List<SessionSyncEntry>,
        unchangedCount: Int,
        hasMore: Boolean,
        nextCursor: String?
    ) {
        val now = Instant.now().toString()
        val responseMode = syncIndexMode
        val immediateAckEntries = mutableListOf<SessionSyncEntry>()
        _uiState.update { state ->
            val sessions = mergeSessions(state.sessions, entries.map { it.session })
            val nextCloudStates = state.cloudSyncStates.toMutableMap()
            entries.forEach { entry ->
                nextCloudStates[entry.session.sessionId] = CloudSyncState(
                    sessionId = entry.session.sessionId,
                    snapshotRevision = entry.snapshotRevision,
                    stageRevision = entry.stageRevision,
                    syncRevision = entry.syncRevision,
                    relayTimelineNewestCursor = entry.timelineNewestCursor,
                    relayTimelineOldestCursor = entry.timelineOldestCursor,
                    lastSyncIndexAt = now,
                    lastAckAt = state.cloudSyncStates[entry.session.sessionId]?.lastAckAt.orEmpty()
                )
                confirmedSessionIds.add(entry.session.sessionId)
                if ((entry.recommendedAction == "snapshot_only" || entry.recommendedAction == "none")
                    && !entryHasTimelineCursorDrift(entry)
                ) {
                    immediateAckEntries.add(entry)
                }
            }
            val archived = RelayStateReducers.mergeCloudArchivedSessions(state.archivedSessionIds, entries)
            val pinned = RelayStateReducers.mergeCloudPinnedSessions(state.pinnedSessionIds, entries, archived)
            cacheStore.saveSessions(sessions)
            cacheStore.saveCloudSyncStates(nextCloudStates.values)
            cacheStore.saveArchivedSessionIds(archived)
            cacheStore.savePinnedSessionIds(pinned)
            persistSessionSyncMarkers()
            state.copy(
                sessions = sessions,
                selectedSessionId = state.selectedSessionId ?: sessions.firstOrNull()?.sessionId,
                archivedSessionIds = archived,
                pinnedSessionIds = pinned,
                confirmedSessionIds = confirmedSessionIds.toSet(),
                cloudSyncStates = nextCloudStates,
                syncIndexSupported = true,
                lastSyncIndexAt = now,
                lastSyncIndexDirtyCount = entries.count { it.dirty },
                lastSyncIndexUnchangedCount = unchangedCount,
                syncState = buildSyncState(
                    active = pendingTimelineSyncIds.isNotEmpty(),
                    summary = syncIndexSummary(
                        mode = responseMode,
                        dirtyCount = entries.count { it.dirty },
                        unchangedCount = unchangedCount,
                        entryCount = entries.size
                    ),
                    dirtySessionCount = entries.count { it.dirty },
                    unchangedSessionCount = unchangedCount,
                    prioritySessionCount = if (responseMode == SyncIndexMode.Priority) entries.size else 0
                ),
                lastHealthCheck = syncIndexSummary(
                    mode = responseMode,
                    dirtyCount = entries.count { it.dirty },
                    unchangedCount = unchangedCount,
                    entryCount = entries.size
                ),
                lastError = null
            )
        }
        if (immediateAckEntries.isNotEmpty()) {
            relayClient.ackSessionSync(immediateAckEntries)
            markCloudAcked(immediateAckEntries.map { it.session.sessionId })
        }
        entries
            .filter { it.recommendedAction == "timeline_page" || it.recommendedAction == "resync_from_host" }
            .filter { shouldSyncCloudEntry(it) }
            .take(MAX_INCREMENTAL_AUTO_SYNC_SESSIONS)
            .forEach { syncSession(it.session.sessionId) }
        updateSyncState()
        if (hasMore && !nextCursor.isNullOrBlank()) {
            _uiState.update { it.copy(lastHealthCheck = "More Relay sync index pages available") }
        }
        val priorityRequested = maybeRequestPrioritySyncIndex(entries, responseMode)
        if (!priorityRequested) {
            syncIndexMode = SyncIndexMode.Incremental
        }
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

    override fun onHealthDiagnostics(diagnostics: ConnectionDiagnostics) {
        _uiState.update { it.copy(connectionDiagnostics = diagnostics) }
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
        if (message.contains("Unsupported message type: session.sync.index", ignoreCase = true)) {
            _uiState.update {
                it.copy(
                    syncIndexSupported = false,
                    lastHealthCheck = "Relay sync index unsupported; using local incremental sync",
                    lastError = null
                )
            }
            syncIncrementalKnownSessions()
            return
        }
        if (_uiState.value.timelineLoadingEarlier) {
            cancelEarlierTimelineTimeout()
        }
        _uiState.update { it.copy(timelineLoadingEarlier = false, syncState = buildSyncState(active = false), lastError = message) }
    }

    fun refreshAllSessions() {
        if (_uiState.value.syncIndexSupported) {
            requestSessionSyncIndex(includeClean = true, mode = SyncIndexMode.Full)
        } else {
            syncIncrementalKnownSessions()
        }
    }

    override fun onCleared() {
        reconnectJob?.cancel()
        timelineSyncTimeoutJobs.values.forEach { it.cancel() }
        timelineSyncTimeoutJobs.clear()
        cancelEarlierTimelineTimeout()
        relayClient.close(clearPendingAcks = true)
        super.onCleared()
    }

    private enum class SyncIndexMode {
        Incremental,
        Priority,
        ArchiveConfirm,
        Full
    }

    private companion object {
        const val MAX_TIMELINE_ITEMS_PER_SESSION = 10000
        const val MAX_APPROVAL_ITEMS = 50
        const val MAX_NOTIFICATION_ITEMS = 200
        const val TIMELINE_PAGE_SIZE = 80
        const val SYNC_INDEX_PAGE_LIMIT = 80
        const val PRIORITY_SYNC_INDEX_LIMIT = 12
        const val MAX_RECONNECT_DELAY_MS = 30_000L
        const val FOREGROUND_REFRESH_INTERVAL_MS = 30_000L
        const val TIMELINE_SYNC_TIMEOUT_MS = 20_000L
        const val MAX_TIMELINE_SYNC_IN_FLIGHT = 1
        const val MAX_INCREMENTAL_AUTO_SYNC_SESSIONS = 4

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

        fun syncIndexCheckingSummary(mode: SyncIndexMode): String =
            when (mode) {
                SyncIndexMode.Incremental -> "Checking recent updates"
                SyncIndexMode.Priority -> "Refreshing priority sessions"
                SyncIndexMode.ArchiveConfirm -> "Confirming archive state"
                SyncIndexMode.Full -> "Refreshing all sessions"
            }

        fun syncIndexSummary(
            mode: SyncIndexMode,
            dirtyCount: Int,
            unchangedCount: Int,
            entryCount: Int
        ): String =
            when (mode) {
                SyncIndexMode.Priority -> "Priority refresh: $entryCount session${if (entryCount == 1) "" else "s"}"
                SyncIndexMode.ArchiveConfirm -> "Archive state refreshed"
                SyncIndexMode.Full -> "Full refresh: $entryCount session${if (entryCount == 1) "" else "s"}, $unchangedCount unchanged"
                SyncIndexMode.Incremental -> if (dirtyCount == 0 && entryCount == 0) {
                    "Up to date: $unchangedCount unchanged"
                } else {
                    "Updates: $dirtyCount changed, $unchangedCount unchanged"
                }
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
        if (sessionId in timelineSyncInFlightIds) {
            return
        }
        if (sessionId !in pendingTimelineSyncIds) {
            pendingTimelineSyncIds.add(sessionId)
            persistSessionSyncMarkers()
            updateSyncState()
        }
        if (sessionId !in timelineSyncQueueIds) {
            timelineSyncQueueIds.addLast(sessionId)
        }
        drainTimelineSyncQueue()
    }

    private fun drainTimelineSyncQueue() {
        while (timelineSyncInFlightIds.size < MAX_TIMELINE_SYNC_IN_FLIGHT && timelineSyncQueueIds.isNotEmpty()) {
            val sessionId = timelineSyncQueueIds.removeFirst()
            if (sessionId !in confirmedSessionIds || sessionId in timelineSyncInFlightIds) {
                continue
            }
            startTimelineSync(sessionId)
        }
        updateSyncState()
    }

    private fun startTimelineSync(sessionId: String) {
        val latestCursor = latestCursorFor(sessionId) ?: cacheStore.syncState(sessionId)?.latestCursor
        val cloudNewestCursor = _uiState.value.cloudSyncStates[sessionId]?.relayTimelineNewestCursor ?: 0L
        val localLatestCursor = latestCursor?.toLongOrNull() ?: 0L
        val afterCursor = if (RelayStateReducers.isTimelineCursorDrift(localLatestCursor, cloudNewestCursor)) {
            cacheStore.clearTimelineForSession(sessionId)
            _uiState.update { state ->
                state.copy(
                    timeline = state.timeline.filterNot { it.sessionId == sessionId },
                    timelineHasMoreEarlier = state.timelineHasMoreEarlier - sessionId,
                    lastHealthCheck = "Refreshing timeline after cursor drift"
                )
            }
            null
        } else {
            latestCursor
        }
        pendingTimelineSyncIds.add(sessionId)
        timelineSyncInFlightIds.add(sessionId)
        persistSessionSyncMarkers()
        updateSyncState()
        scheduleTimelineSyncTimeout(sessionId)
        val sent = relayClient.requestTimeline(
            sessionId = sessionId,
            afterCursor = afterCursor,
            limit = TIMELINE_PAGE_SIZE,
            page = true
        )
        if (!sent) {
            pendingTimelineSyncIds.remove(sessionId)
            timelineSyncInFlightIds.remove(sessionId)
            cancelTimelineSyncTimeout(sessionId)
            persistSessionSyncMarkers()
            updateSyncState()
        }
    }

    private fun refreshLatestTimeline(sessionId: String) {
        if (sessionId in timelineSyncInFlightIds) {
            return
        }
        pendingTimelineSyncIds.add(sessionId)
        timelineSyncInFlightIds.add(sessionId)
        persistSessionSyncMarkers()
        updateSyncState()
        scheduleTimelineSyncTimeout(sessionId)
        val sent = relayClient.requestTimeline(
            sessionId = sessionId,
            limit = TIMELINE_PAGE_SIZE,
            page = true
        )
        if (!sent) {
            pendingTimelineSyncIds.remove(sessionId)
            timelineSyncInFlightIds.remove(sessionId)
            cancelTimelineSyncTimeout(sessionId)
            persistSessionSyncMarkers()
            updateSyncState()
        }
    }

    private fun syncIncrementalKnownSessions() {
        incrementalSyncCandidates(_uiState.value)
            .forEach { session -> syncSession(session.sessionId) }
        updateSyncState()
    }

    private fun requestSessionSyncIndex(
        includeClean: Boolean = false,
        includeArchived: Boolean = false,
        mode: SyncIndexMode = SyncIndexMode.Incremental,
        sessionIds: List<String> = emptyList()
    ) {
        if (_uiState.value.deviceToken.isBlank()) {
            return
        }
        syncIndexMode = mode
        val sent = relayClient.requestSessionSyncIndex(
            selectedSessionId = _uiState.value.selectedSessionId,
            limit = if (mode == SyncIndexMode.Priority) PRIORITY_SYNC_INDEX_LIMIT else SYNC_INDEX_PAGE_LIMIT,
            includeArchived = includeArchived || mode == SyncIndexMode.Full,
            includeClean = includeClean,
            sessionIds = sessionIds
        )
        if (sent) {
            _uiState.update {
                it.copy(
                    syncState = buildSyncState(active = true, summary = syncIndexCheckingSummary(mode)),
                    lastHealthCheck = syncIndexCheckingSummary(mode),
                    lastError = null
                )
            }
        }
    }

    private fun maybeRequestPrioritySyncIndex(entries: List<SessionSyncEntry>, responseMode: SyncIndexMode): Boolean {
        if (prioritySyncIndexRequested || responseMode != SyncIndexMode.Incremental) {
            return false
        }
        val prioritySessionIds = RelayStateReducers.prioritySyncSessions(
            sessions = _uiState.value.sessions,
            selectedSessionId = _uiState.value.selectedSessionId,
            archivedSessionIds = _uiState.value.archivedSessionIds,
            limit = PRIORITY_SYNC_INDEX_LIMIT
        ).map { it.sessionId }

        if (prioritySessionIds.isEmpty()) {
            return false
        }

        val returnedIds = entries.map { it.session.sessionId }.toSet()
        if (prioritySessionIds.all { it in returnedIds }) {
            return false
        }

        prioritySyncIndexRequested = true
        requestSessionSyncIndex(
            includeClean = true,
            mode = SyncIndexMode.Priority,
            sessionIds = prioritySessionIds
        )
        return true
    }

    private fun mergeSessions(current: List<CodexSession>, incoming: List<CodexSession>): List<CodexSession> {
        val incomingIds = incoming.map { it.sessionId }.toSet()
        return (incoming + current.filterNot { it.sessionId in incomingIds })
            .sortedByDescending { parseIsoMillis(it.updatedAt) }
    }

    private fun shouldSyncCloudEntry(entry: SessionSyncEntry): Boolean {
        val session = entry.session
        if (session.sessionId in _uiState.value.archivedSessionIds) {
            return false
        }
        if (session.sessionId == _uiState.value.selectedSessionId) {
            return true
        }
        if (session.stage.severity == "active" || session.stage.severity == "warning") {
            return true
        }
        val localLatest = latestCursorFor(session.sessionId)?.toLongOrNull()
            ?: cacheStore.syncState(session.sessionId)?.latestCursor?.toLongOrNull()
            ?: 0L
        return localLatest == 0L
            || localLatest < entry.timelineNewestCursor
            || RelayStateReducers.isTimelineCursorDrift(localLatest, entry.timelineNewestCursor)
    }

    private fun cloudSyncNeedsTimeline(sessionId: String): Boolean {
        val cloud = _uiState.value.cloudSyncStates[sessionId] ?: return true
        val localLatest = latestCursorFor(sessionId)?.toLongOrNull()
            ?: cacheStore.syncState(sessionId)?.latestCursor?.toLongOrNull()
            ?: 0L
        return localLatest < cloud.relayTimelineNewestCursor
            || RelayStateReducers.isTimelineCursorDrift(localLatest, cloud.relayTimelineNewestCursor)
    }

    private fun ackCloudSyncIfCaughtUp(sessionId: String) {
        val cloud = _uiState.value.cloudSyncStates[sessionId] ?: return
        val session = _uiState.value.sessions.firstOrNull { it.sessionId == sessionId } ?: return
        val localLatest = latestCursorFor(sessionId)?.toLongOrNull()
            ?: cacheStore.syncState(sessionId)?.latestCursor?.toLongOrNull()
            ?: 0L
        if (localLatest < cloud.relayTimelineNewestCursor
            || RelayStateReducers.isTimelineCursorDrift(localLatest, cloud.relayTimelineNewestCursor)
        ) {
            return
        }
        val entry = SessionSyncEntry(
            session = session,
            snapshotRevision = cloud.snapshotRevision,
            stageRevision = cloud.stageRevision,
            syncRevision = cloud.syncRevision,
            timelineNewestCursor = cloud.relayTimelineNewestCursor,
            timelineOldestCursor = cloud.relayTimelineOldestCursor,
            dirty = false,
            dirtyReasons = emptyList(),
            recommendedAction = "none"
        )
        if (relayClient.ackSessionSync(listOf(entry))) {
            markCloudAcked(listOf(sessionId))
        }
    }

    private fun markCloudAcked(sessionIds: List<String>) {
        val ackedAt = Instant.now().toString()
        _uiState.update { state ->
            val nextCloudStates = state.cloudSyncStates.toMutableMap()
            sessionIds.forEach { sessionId ->
                val current = nextCloudStates[sessionId]
                if (current != null) {
                    nextCloudStates[sessionId] = current.copy(lastAckAt = ackedAt)
                }
            }
            cacheStore.saveCloudSyncStates(nextCloudStates.values)
            state.copy(cloudSyncStates = nextCloudStates)
        }
    }

    private fun entryHasTimelineCursorDrift(entry: SessionSyncEntry): Boolean {
        val localLatest = latestCursorFor(entry.session.sessionId)?.toLongOrNull()
            ?: cacheStore.syncState(entry.session.sessionId)?.latestCursor?.toLongOrNull()
            ?: 0L
        return RelayStateReducers.isTimelineCursorDrift(localLatest, entry.timelineNewestCursor)
    }

    private fun incrementalSyncCandidates(state: RelayUiState): List<CodexSession> {
        val confirmed = liveConfirmedSessionIds()
        return state.activeSessions
            .filter { session -> session.sessionId in confirmed }
            .filter { session -> shouldAutoSyncSession(session) }
            .sortedWith(
                compareByDescending<CodexSession> { it.sessionId == state.selectedSessionId }
                    .thenByDescending { sessionPriority(it) }
                    .thenByDescending { parseIsoMillis(it.updatedAt) }
            )
            .take(MAX_INCREMENTAL_AUTO_SYNC_SESSIONS)
    }

    private fun shouldAutoSyncSession(session: CodexSession): Boolean {
        val state = _uiState.value
        if (session.sessionId in state.archivedSessionIds) {
            return false
        }
        if (session.sessionId == state.selectedSessionId) {
            return true
        }
        if (session.stage.severity == "active" || session.stage.severity == "warning") {
            return true
        }
        if (session.status == "running" || session.status == "waiting_for_input") {
            return true
        }
        val syncState = cacheStore.syncState(session.sessionId)
        if (latestCursorFor(session.sessionId).isNullOrBlank() && syncState?.latestCursor.isNullOrBlank()) {
            return true
        }
        val sessionUpdatedAt = parseIsoMillis(session.updatedAt)
        val lastSyncedAt = parseIsoMillis(syncState?.lastSyncedAt.orEmpty())
        return sessionUpdatedAt > lastSyncedAt
    }

    private fun sessionPriority(session: CodexSession): Int = when {
        session.stage.severity == "warning" -> 4
        session.stage.severity == "active" -> 3
        session.status == "running" -> 3
        session.status == "waiting_for_input" -> 2
        latestCursorFor(session.sessionId).isNullOrBlank() && cacheStore.syncState(session.sessionId)?.latestCursor.isNullOrBlank() -> 1
        else -> 0
    }

    private fun resetSessionSyncMarkers() {
        confirmedSessionIds.clear()
        pendingTimelineSyncIds.clear()
        timelineSyncInFlightIds.clear()
        timelineSyncQueueIds.clear()
        timelineSyncTimeoutJobs.values.forEach { it.cancel() }
        timelineSyncTimeoutJobs.clear()
        cancelEarlierTimelineTimeout()
        snapshotSyncedSessionIds.clear()
        persistSessionSyncMarkers()
    }

    private fun persistSessionSyncMarkers() {
        cacheStore.saveConfirmedSessionIds(confirmedSessionIds)
        cacheStore.savePendingTimelineSyncIds(pendingTimelineSyncIds)
    }

    private fun liveConfirmedSessionIds(): Set<String> {
        return RelayStateReducers.liveConfirmedSessionIds(_uiState.value.sessions, confirmedSessionIds)
    }

    private fun shouldRunForegroundRefresh(): Boolean {
        val now = System.currentTimeMillis()
        if (now - lastForegroundRefreshAtMillis < FOREGROUND_REFRESH_INTERVAL_MS) {
            return false
        }
        lastForegroundRefreshAtMillis = now
        return true
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
            relayClient.connect(current.relayUrl, current.activeAuthToken, preservePendingAcks = true)
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
            val confirmed = liveConfirmedSessionIds()
            state.copy(
                syncState = RelayStateReducers.buildSyncState(
                    sessions = state.sessions,
                    confirmedSessionIds = confirmedSessionIds,
                    pendingTimelineSyncIds = pendingTimelineSyncIds,
                    connectionStatus = state.connectionStatus,
                    timelineLoadingEarlier = state.timelineLoadingEarlier
                ),
                confirmedSessionIds = confirmed,
                pendingTimelineSyncIds = pendingTimelineSyncIds.toSet()
            )
        }
    }

    private fun buildSyncState(
        active: Boolean,
        summary: String = "",
        pendingSessionCount: Int = _uiState.value.sessions.count { it.sessionId !in liveConfirmedSessionIds() } + pendingTimelineSyncIds.size,
        totalSessionCount: Int = _uiState.value.sessions.size,
        dirtySessionCount: Int = _uiState.value.lastSyncIndexDirtyCount,
        unchangedSessionCount: Int = _uiState.value.lastSyncIndexUnchangedCount,
        prioritySessionCount: Int = _uiState.value.syncState.prioritySessionCount
    ): SyncState = RelayStateReducers.buildSyncState(
        sessions = _uiState.value.sessions,
        confirmedSessionIds = confirmedSessionIds,
        pendingTimelineSyncIds = pendingTimelineSyncIds,
        connectionStatus = _uiState.value.connectionStatus,
        timelineLoadingEarlier = _uiState.value.timelineLoadingEarlier,
        activeOverride = active,
        summaryOverride = summary,
        pendingSessionCountOverride = pendingSessionCount,
        totalSessionCountOverride = totalSessionCount,
        dirtySessionCount = dirtySessionCount,
        unchangedSessionCount = unchangedSessionCount,
        prioritySessionCount = prioritySessionCount
    )

    private fun mergeTimelineEvents(current: List<TimelineItem>, incoming: List<TimelineItem>): List<TimelineItem> {
        return RelayStateReducers.mergeTimelineEvents(current, incoming, MAX_TIMELINE_ITEMS_PER_SESSION)
    }

    private fun scheduleTimelineSyncTimeout(sessionId: String) {
        cancelTimelineSyncTimeout(sessionId)
        timelineSyncTimeoutJobs[sessionId] = viewModelScope.launch {
            delay(TIMELINE_SYNC_TIMEOUT_MS)
            if (sessionId !in timelineSyncInFlightIds) {
                return@launch
            }
            pendingTimelineSyncIds.remove(sessionId)
            timelineSyncInFlightIds.remove(sessionId)
            timelineSyncTimeoutJobs.remove(sessionId)
            persistSessionSyncMarkers()
            _uiState.update {
                it.copy(
                    pendingTimelineSyncIds = pendingTimelineSyncIds.toSet(),
                    lastError = "Timeline sync timed out for $sessionId"
                )
            }
            updateSyncState()
            drainTimelineSyncQueue()
        }
    }

    private fun cancelTimelineSyncTimeout(sessionId: String) {
        timelineSyncTimeoutJobs.remove(sessionId)?.cancel()
    }

    private fun scheduleEarlierTimelineTimeout(sessionId: String) {
        cancelEarlierTimelineTimeout()
        earlierTimelineTimeoutJob = viewModelScope.launch {
            delay(TIMELINE_SYNC_TIMEOUT_MS)
            if (!_uiState.value.timelineLoadingEarlier) {
                return@launch
            }
            _uiState.update {
                it.copy(
                    timelineLoadingEarlier = false,
                    lastError = "Loading earlier history timed out for $sessionId"
                )
            }
            updateSyncState()
        }
    }

    private fun cancelEarlierTimelineTimeout() {
        earlierTimelineTimeoutJob?.cancel()
        earlierTimelineTimeoutJob = null
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
