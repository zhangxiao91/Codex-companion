package dev.codexmobile.companion

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class RelayStateReducersTest {
    @Test
    fun restoreRelayRequestPhaseConvertsTransientStatesToInterrupted() {
        assertEquals("interrupted", RelayStateReducers.restoreRelayRequestPhase("waiting_ack"))
        assertEquals("interrupted", RelayStateReducers.restoreRelayRequestPhase("retrying"))
    }

    @Test
    fun restoreRelayRequestPhaseKeepsTerminalAndBlankStates() {
        assertEquals("sent", RelayStateReducers.restoreRelayRequestPhase("sent"))
        assertEquals("failed", RelayStateReducers.restoreRelayRequestPhase("failed"))
        assertEquals("", RelayStateReducers.restoreRelayRequestPhase(""))
    }

    @Test
    fun liveConfirmedSessionIdsOnlyIncludesVisibleSessions() {
        val sessions = listOf(session("a"), session("b"))

        assertEquals(
            setOf("a"),
            RelayStateReducers.liveConfirmedSessionIds(
                sessions = sessions,
                confirmedSessionIds = setOf("a", "stale-cache-only")
            )
        )
    }

    @Test
    fun buildSyncStateTreatsCachedUnconfirmedSessionsAsPending() {
        val syncState = RelayStateReducers.buildSyncState(
            sessions = listOf(session("cached"), session("live")),
            confirmedSessionIds = setOf("live", "old"),
            pendingTimelineSyncIds = emptySet(),
            connectionStatus = "Online",
            timelineLoadingEarlier = false
        )

        assertTrue(syncState.active)
        assertEquals(1, syncState.pendingSessionCount)
        assertEquals(1, syncState.confirmedSessionCount)
        assertEquals(2, syncState.totalSessionCount)
        assertEquals("Confirming 1 session", syncState.summary)
    }

    @Test
    fun buildSyncStateIncludesPendingTimelineWork() {
        val syncState = RelayStateReducers.buildSyncState(
            sessions = listOf(session("a"), session("b")),
            confirmedSessionIds = setOf("a", "b"),
            pendingTimelineSyncIds = setOf("a", "b"),
            connectionStatus = "Online",
            timelineLoadingEarlier = false
        )

        assertTrue(syncState.active)
        assertEquals(2, syncState.pendingSessionCount)
        assertEquals(2, syncState.confirmedSessionCount)
        assertEquals("Syncing timeline for 2 sessions", syncState.summary)
    }

    @Test
    fun buildSyncStateMarksEarlierHistoryLoadAsActive() {
        val syncState = RelayStateReducers.buildSyncState(
            sessions = listOf(session("a")),
            confirmedSessionIds = setOf("a"),
            pendingTimelineSyncIds = emptySet(),
            connectionStatus = "Online",
            timelineLoadingEarlier = true
        )

        assertTrue(syncState.active)
        assertEquals(0, syncState.pendingSessionCount)
        assertEquals("Loading earlier history", syncState.summary)
    }

    @Test
    fun buildSyncStateCanRepresentIdleFullySyncedState() {
        val syncState = RelayStateReducers.buildSyncState(
            sessions = listOf(session("a")),
            confirmedSessionIds = setOf("a"),
            pendingTimelineSyncIds = emptySet(),
            connectionStatus = "Online",
            timelineLoadingEarlier = false
        )

        assertFalse(syncState.active)
        assertEquals(0, syncState.pendingSessionCount)
        assertEquals(1, syncState.confirmedSessionCount)
        assertEquals("", syncState.summary)
    }

    @Test
    fun relayUiStateSeparatesActiveAndArchivedSessions() {
        val state = RelayUiState(
            sessions = listOf(session("active"), session("archived")),
            archivedSessionIds = setOf("archived")
        )

        assertEquals(listOf("active"), state.activeSessions.map { it.sessionId })
        assertEquals(listOf("archived"), state.archivedSessions.map { it.sessionId })
    }

    @Test
    fun mergeCloudArchivedSessionsUnarchivesReturnedCleanCloudSessions() {
        val archived = RelayStateReducers.mergeCloudArchivedSessions(
            currentArchivedSessionIds = setOf("stale-local", "local-only", "cloud-archived"),
            entries = listOf(
                syncEntry("stale-local"),
                syncEntry("cloud-archived", archivedAt = "2026-05-24T00:00:00Z")
            )
        )

        assertEquals(setOf("local-only", "cloud-archived"), archived)
    }

    @Test
    fun mergeCloudPinnedSessionsUnpinsReturnedCleanCloudSessionsAndDropsArchivedPins() {
        val pinned = RelayStateReducers.mergeCloudPinnedSessions(
            currentPinnedSessionIds = setOf("stale-local-pin", "local-only-pin", "cloud-pinned", "cloud-archived"),
            entries = listOf(
                syncEntry("stale-local-pin"),
                syncEntry("cloud-pinned", pinnedAt = "2026-05-24T00:00:00Z"),
                syncEntry(
                    "cloud-archived",
                    archivedAt = "2026-05-24T00:00:00Z",
                    pinnedAt = "2026-05-24T00:00:00Z"
                )
            ),
            archivedSessionIds = setOf("cloud-archived")
        )

        assertEquals(setOf("local-only-pin", "cloud-pinned"), pinned)
    }

    @Test
    fun isTimelineCursorDriftOnlyWhenLocalCursorExceedsRelayNewest() {
        assertTrue(RelayStateReducers.isTimelineCursorDrift(localLatestCursor = 120, relayNewestCursor = 80))
        assertFalse(RelayStateReducers.isTimelineCursorDrift(localLatestCursor = 80, relayNewestCursor = 80))
        assertFalse(RelayStateReducers.isTimelineCursorDrift(localLatestCursor = 0, relayNewestCursor = 80))
        assertFalse(RelayStateReducers.isTimelineCursorDrift(localLatestCursor = 120, relayNewestCursor = 0))
    }

    @Test
    fun mergeApprovalUpsertsPendingApprovalAtTopAndKeepsLimit() {
        val existing = listOf(
            approval("old-1"),
            approval("old-2")
        )
        val updated = RelayStateReducers.mergeApproval(
            current = existing,
            incoming = approval("old-2", summary = "updated"),
            maxItems = 2
        )

        assertEquals(listOf("old-2", "old-1"), updated.map { it.approvalId })
        assertEquals("updated", updated.first().summary)
    }

    @Test
    fun mergeApprovalDropsResolvedApproval() {
        val updated = RelayStateReducers.mergeApproval(
            current = listOf(approval("a"), approval("b")),
            incoming = approval("a", status = "approved"),
            maxItems = 50
        )

        assertEquals(listOf("b"), updated.map { it.approvalId })
        assertEquals(setOf("b"), RelayStateReducers.pendingApprovalIds(updated))
    }

    @Test
    fun mergeTimelineEventsDeduplicatesSortsAndTrimsPerSession() {
        val current = listOf(
            event("old-low", "a", "1"),
            event("replace-me", "a", "2", summary = "old"),
            event("other-session", "b", "9")
        )
        val incoming = listOf(
            event("new-high", "a", "4"),
            event("replace-me", "a", "3", summary = "new")
        )

        val merged = RelayStateReducers.mergeTimelineEvents(
            current = current,
            incoming = incoming,
            maxItemsPerSession = 2
        )

        assertEquals(listOf("other-session", "new-high", "replace-me"), merged.map { it.eventId })
        assertEquals("new", merged.first { it.eventId == "replace-me" }.summary)
        assertFalse(merged.any { it.eventId == "old-low" })
    }

    @Test
    fun updatePromptQueueStateTracksQueuedAndStartedEvents() {
        val queued = RelayStateReducers.updatePromptQueueState(
            current = emptyMap(),
            event = event("queued", "a", "1", type = "prompt_queued", summary = "Queued prompt 2/5.")
        )

        assertEquals(PromptQueueState("a", depth = 2, maxDepth = 5), queued["a"])

        val started = RelayStateReducers.updatePromptQueueState(
            current = queued,
            event = event("started", "a", "2", type = "prompt_queue_started", summary = "Started queued prompt. 1/5 queued.")
        )

        assertEquals(PromptQueueState("a", depth = 1, maxDepth = 5), started["a"])

        val drained = RelayStateReducers.updatePromptQueueState(
            current = started,
            event = event("drained", "a", "3", type = "prompt_queue_started", summary = "Started queued prompt. 0/5 queued.")
        )

        assertFalse("a" in drained)
    }

    private fun session(
        id: String,
        status: String = "completed",
        updatedAt: String = "2026-05-24T00:00:00Z"
    ): CodexSession = CodexSession(
        sessionId = id,
        hostId = "host",
        projectName = "Project",
        repoPath = "C:/repo",
        branch = "main",
        status = status,
        summary = "",
        updatedAt = updatedAt
    )

    private fun approval(
        id: String,
        status: String = "pending",
        summary: String = "summary"
    ): ApprovalItem = ApprovalItem(
        approvalId = id,
        sessionId = "session",
        kind = "command",
        title = "Approval",
        summary = summary,
        command = "echo ok",
        riskLevel = "medium",
        status = status,
        requestedAt = "2026-05-24T00:00:00Z"
    )

    private fun event(
        id: String,
        sessionId: String,
        cursor: String,
        type: String = "message",
        summary: String = "summary"
    ): TimelineItem = TimelineItem(
        eventId = id,
        sessionId = sessionId,
        type = type,
        title = "Event",
        summary = summary,
        createdAt = "2026-05-24T00:00:0${cursor.takeLast(1)}Z",
        cursor = cursor
    )

    private fun syncEntry(
        id: String,
        archivedAt: String? = null,
        pinnedAt: String? = null
    ): SessionSyncEntry = SessionSyncEntry(
        session = session(id),
        snapshotRevision = 1,
        stageRevision = 1,
        syncRevision = 1,
        timelineNewestCursor = 0,
        timelineOldestCursor = null,
        dirty = false,
        dirtyReasons = emptyList(),
        recommendedAction = "none",
        archivedAt = archivedAt,
        pinnedAt = pinnedAt
    )
}
