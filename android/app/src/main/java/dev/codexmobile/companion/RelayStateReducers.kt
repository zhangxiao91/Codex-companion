package dev.codexmobile.companion

internal object RelayStateReducers {
    fun restoreRelayRequestPhase(phase: String): String =
        when (phase) {
            "waiting_ack", "retrying" -> "interrupted"
            else -> phase
        }

    fun liveConfirmedSessionIds(
        sessions: List<CodexSession>,
        confirmedSessionIds: Set<String>
    ): Set<String> = confirmedSessionIds.intersect(sessions.map { it.sessionId }.toSet())

    fun pendingApprovalIds(approvals: List<ApprovalItem>): Set<String> =
        approvals.filter { it.status == "pending" }.map { it.approvalId }.toSet()

    fun mergeApproval(
        current: List<ApprovalItem>,
        incoming: ApprovalItem,
        maxItems: Int
    ): List<ApprovalItem> =
        if (incoming.status == "pending") {
            (listOf(incoming) + current.filter { it.approvalId != incoming.approvalId })
                .take(maxItems)
        } else {
            current.filter { it.approvalId != incoming.approvalId }
        }

    fun mergeCloudArchivedSessions(
        currentArchivedSessionIds: Set<String>,
        entries: List<SessionSyncEntry>
    ): Set<String> {
        val cloudKnownSessionIds = entries.map { it.session.sessionId }.toSet()
        val cloudArchivedSessionIds = entries
            .mapNotNull { entry -> entry.session.sessionId.takeIf { !entry.archivedAt.isNullOrBlank() } }
            .toSet()
        return (currentArchivedSessionIds - cloudKnownSessionIds) + cloudArchivedSessionIds
    }

    fun mergeCloudPinnedSessions(
        currentPinnedSessionIds: Set<String>,
        entries: List<SessionSyncEntry>,
        archivedSessionIds: Set<String>
    ): Set<String> {
        val cloudKnownSessionIds = entries.map { it.session.sessionId }.toSet()
        val cloudPinnedSessionIds = entries
            .mapNotNull { entry ->
                entry.session.sessionId.takeIf {
                    !entry.pinnedAt.isNullOrBlank() && entry.archivedAt.isNullOrBlank()
                }
            }
            .toSet()
        return ((currentPinnedSessionIds - cloudKnownSessionIds) + cloudPinnedSessionIds) - archivedSessionIds
    }

    fun isTimelineCursorDrift(localLatestCursor: Long, relayNewestCursor: Long): Boolean =
        relayNewestCursor > 0 && localLatestCursor > relayNewestCursor

    fun buildSyncState(
        sessions: List<CodexSession>,
        confirmedSessionIds: Set<String>,
        pendingTimelineSyncIds: Set<String>,
        connectionStatus: String,
        timelineLoadingEarlier: Boolean,
        activeOverride: Boolean? = null,
        summaryOverride: String? = null,
        pendingSessionCountOverride: Int? = null,
        totalSessionCountOverride: Int? = null,
        dirtySessionCount: Int = 0,
        unchangedSessionCount: Int = 0,
        prioritySessionCount: Int = 0
    ): SyncState {
        val liveConfirmed = liveConfirmedSessionIds(sessions, confirmedSessionIds)
        val pendingSessions = sessions.count { it.sessionId !in liveConfirmed }
        val pendingTimeline = pendingTimelineSyncIds.size
        val active = activeOverride
            ?: (connectionStatus == "Connecting" || pendingSessions > 0 || pendingTimeline > 0 || timelineLoadingEarlier)
        val summary = summaryOverride ?: when {
            connectionStatus == "Connecting" -> "Connecting and syncing sessions"
            pendingSessions > 0 -> "Confirming ${pendingSessions} session${if (pendingSessions == 1) "" else "s"}"
            pendingTimeline > 0 -> "Syncing timeline for ${pendingTimeline} session${if (pendingTimeline == 1) "" else "s"}"
            timelineLoadingEarlier -> "Loading earlier history"
            else -> ""
        }
        val pendingCount = pendingSessionCountOverride ?: (pendingSessions + pendingTimeline)
        val totalCount = totalSessionCountOverride ?: sessions.size

        return SyncState(
            active = active,
            pendingSessionCount = pendingCount,
            confirmedSessionCount = sessions.count { it.sessionId in liveConfirmed },
            totalSessionCount = totalCount,
            dirtySessionCount = dirtySessionCount,
            unchangedSessionCount = unchangedSessionCount,
            prioritySessionCount = prioritySessionCount,
            summary = summary
        )
    }

    fun prioritySyncSessions(
        sessions: List<CodexSession>,
        selectedSessionId: String?,
        archivedSessionIds: Set<String>,
        limit: Int
    ): List<CodexSession> =
        sessions
            .asSequence()
            .filterNot { it.sessionId in archivedSessionIds }
            .sortedWith(
                compareByDescending<CodexSession> { it.sessionId == selectedSessionId }
                    .thenByDescending { sessionSyncPriority(it, selectedSessionId) }
                    .thenByDescending { parseIsoMillis(it.updatedAt) }
            )
            .take(limit.coerceAtLeast(0))
            .toList()

    private fun sessionSyncPriority(session: CodexSession, selectedSessionId: String?): Int =
        when {
            session.sessionId == selectedSessionId -> 5
            session.stage.severity == "warning" -> 4
            session.stage.severity == "active" -> 3
            session.status == "running" -> 3
            session.status == "waiting_for_input" -> 2
            else -> 0
        }

    private fun parseIsoMillis(raw: String): Long =
        runCatching { java.time.Instant.parse(raw).toEpochMilli() }.getOrDefault(0L)

    fun mergeTimelineEvents(
        current: List<TimelineItem>,
        incoming: List<TimelineItem>,
        maxItemsPerSession: Int
    ): List<TimelineItem> {
        if (incoming.isEmpty()) {
            return current
        }

        val incomingIds = incoming.map { it.eventId }.toSet()
        return (incoming + current.filter { it.eventId !in incomingIds })
            .sortedWith(
                compareByDescending<TimelineItem> { it.cursor?.toLongOrNull() ?: Long.MIN_VALUE }
                    .thenByDescending { it.createdAt }
            )
            .groupBy { it.sessionId }
            .values
            .flatMap { it.take(maxItemsPerSession) }
            .sortedWith(
                compareByDescending<TimelineItem> { it.cursor?.toLongOrNull() ?: Long.MIN_VALUE }
                    .thenByDescending { it.createdAt }
            )
    }

    fun updatePromptQueueState(
        current: Map<String, PromptQueueState>,
        event: TimelineItem
    ): Map<String, PromptQueueState> {
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
}
