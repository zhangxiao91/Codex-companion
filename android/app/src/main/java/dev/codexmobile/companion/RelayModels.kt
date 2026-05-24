package dev.codexmobile.companion

data class CodexSession(
    val sessionId: String,
    val hostId: String,
    val projectName: String,
    val repoPath: String,
    val branch: String,
    val status: String,
    val summary: String,
    val updatedAt: String,
    val stage: SessionStage = SessionStage.fromStatus(status, summary, updatedAt)
)

data class SessionStage(
    val type: String,
    val label: String,
    val summary: String,
    val severity: String,
    val updatedAt: String
) {
    companion object {
        fun fromStatus(status: String, summary: String, updatedAt: String): SessionStage {
            val normalized = status.lowercase()
            return when (normalized) {
                "running" -> SessionStage("thinking", "Thinking", summary.ifBlank { "Codex is working." }, "active", updatedAt)
                "waiting_for_input" -> SessionStage("needs_user", "Needs input", summary.ifBlank { "Codex is waiting for your input." }, "warning", updatedAt)
                "completed" -> SessionStage("completed", "Completed", summary.ifBlank { "Codex completed the latest work." }, "success", updatedAt)
                else -> SessionStage("idle", "Idle", summary.ifBlank { "No active Codex work is running." }, "neutral", updatedAt)
            }
        }
    }
}

data class TimelineItem(
    val eventId: String,
    val sessionId: String,
    val type: String,
    val title: String,
    val summary: String,
    val createdAt: String,
    val cursor: String?,
    val payloadJson: String = "",
    val turnId: String? = null,
    val itemId: String? = null,
    val clientRequestId: String? = null
)

data class NotificationEvent(
    val notificationId: String,
    val kind: String,
    val sessionId: String?,
    val hostId: String?,
    val title: String,
    val summary: String,
    val createdAt: String
)

data class PromptDraft(
    val text: String,
    val attachments: List<PromptAttachment> = emptyList(),
    val reasoningEffort: String = "auto",
    val planModeOnce: Boolean = false,
    val goalModeOnce: Boolean = false,
    val goalObjective: String = "",
    val editingBaseEventId: String? = null,
    val editingBaseTurnId: String? = null,
    val clientRequestId: String = java.util.UUID.randomUUID().toString()
)

data class PromptQueueState(
    val sessionId: String,
    val depth: Int,
    val maxDepth: Int
)

data class PromptAttachment(
    val attachmentId: String = java.util.UUID.randomUUID().toString(),
    val displayName: String,
    val mimeType: String,
    val dataUrl: String,
    val sizeBytes: Int,
    val width: Int? = null,
    val height: Int? = null
)

data class HostNode(
    val hostId: String,
    val displayName: String,
    val status: String,
    val capabilities: List<String>,
    val sessionCount: Int,
    val lastSeenAt: String,
    val bridgeVersion: String,
    val kind: String
)

data class PowerStatus(
    val hostId: String,
    val platform: String,
    val powerControlEnabled: Boolean,
    val allowKeepAwake: Boolean,
    val allowLock: Boolean,
    val keepAwakeActive: Boolean,
    val keepAwakeUntil: String?,
    val mockMode: Boolean,
    val policyPath: String,
    val checkedAt: String
)

data class PowerTrustChallenge(
    val hostId: String,
    val challengeId: String,
    val deviceId: String,
    val expiresAt: String,
    val message: String
)

data class PowerTrust(
    val hostId: String,
    val deviceId: String,
    val capabilities: List<String>,
    val expiresAt: String?
)

data class PowerResult(
    val hostId: String,
    val deviceId: String,
    val action: String,
    val status: String,
    val reason: String,
    val expiresAt: String?
)

data class ApprovalItem(
    val approvalId: String,
    val sessionId: String,
    val kind: String,
    val title: String,
    val summary: String,
    val command: String,
    val riskLevel: String,
    val status: String,
    val requestedAt: String
)

data class GitFileChange(
    val path: String,
    val indexStatus: String,
    val worktreeStatus: String,
    val tracked: Boolean
)

data class GitSnapshot(
    val sessionId: String,
    val action: String,
    val repoPath: String,
    val branch: String,
    val isGitRepo: Boolean,
    val statusSummary: String,
    val trackedFileCount: Int,
    val untrackedFileCount: Int,
    val commitStrategy: String,
    val files: List<GitFileChange>,
    val diffStat: String,
    val selectedFilePath: String,
    val selectedFileDiff: String,
    val selectedFileDiffTruncated: Boolean,
    val resultOk: Boolean?,
    val resultMessage: String,
    val error: String,
    val updatedAt: String
)

data class GitAuditItem(
    val eventId: String,
    val auditId: String,
    val sessionId: String,
    val hostId: String,
    val phase: String,
    val action: String,
    val filePath: String,
    val deviceId: String,
    val deviceDisplayName: String,
    val resultOk: Boolean?,
    val resultMessage: String,
    val changedFileCount: Int?,
    val createdAt: String
)

data class RelayUiState(
    val relayUrl: String = RelayClient.DEFAULT_RELAY_URL,
    val pairingToken: String = "",
    val deviceToken: String = "",
    val deviceId: String = "",
    val connectionStatus: String = "Disconnected",
    val sessions: List<CodexSession> = emptyList(),
    val hosts: List<HostNode> = emptyList(),
    val powerStatuses: Map<String, PowerStatus> = emptyMap(),
    val powerTrusts: Map<String, PowerTrust> = emptyMap(),
    val pendingPowerChallenge: PowerTrustChallenge? = null,
    val lastPowerResult: PowerResult? = null,
    val selectedSessionId: String? = null,
    val pinnedSessionIds: Set<String> = emptySet(),
    val timeline: List<TimelineItem> = emptyList(),
    val approvals: List<ApprovalItem> = emptyList(),
    val gitSnapshots: Map<String, GitSnapshot> = emptyMap(),
    val gitAudit: Map<String, List<GitAuditItem>> = emptyMap(),
    val timelineLoadingEarlier: Boolean = false,
    val timelineHasMoreEarlier: Map<String, Boolean> = emptyMap(),
    val promptQueues: Map<String, PromptQueueState> = emptyMap(),
    val notifications: List<NotificationEvent> = emptyList(),
    val relayRequestState: RelayRequestState = RelayRequestState(),
    val relayRequestHistory: List<RelayRequestState> = emptyList(),
    val lastConnectedAt: String? = null,
    val lastHealthCheck: String? = null,
    val lastError: String? = null
) {
    val selectedSession: CodexSession?
        get() = sessions.firstOrNull { it.sessionId == selectedSessionId }

    val pendingApprovals: List<ApprovalItem>
        get() = approvals.filter { it.status == "pending" }

    val selectedGitSnapshot: GitSnapshot?
        get() = selectedSessionId?.let { gitSnapshots[it] }

    val selectedGitAudit: List<GitAuditItem>
        get() = selectedSessionId?.let { gitAudit[it] } ?: emptyList()

    val selectedHost: HostNode?
        get() = selectedSession?.hostId?.let { sessionHostId ->
            hosts.firstOrNull { it.hostId == sessionHostId }
        } ?: hosts.firstOrNull { it.status == "online" }

    val selectedPowerStatus: PowerStatus?
        get() = selectedHost?.hostId?.let { powerStatuses[it] }

    val selectedPowerTrust: PowerTrust?
        get() = selectedHost?.hostId?.let { powerTrusts[it] }

    val selectedPromptQueue: PromptQueueState?
        get() = selectedSessionId?.let { promptQueues[it] }

    val activeAuthToken: String
        get() = deviceToken.ifBlank { pairingToken }
}

data class RelayRequestState(
    val type: String = "",
    val label: String = "",
    val phase: String = "",
    val messageId: String? = null,
    val attempts: Int = 0,
    val updatedAt: String? = null
)
