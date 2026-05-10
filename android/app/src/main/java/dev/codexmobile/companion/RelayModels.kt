package dev.codexmobile.companion

data class CodexSession(
    val sessionId: String,
    val hostId: String,
    val projectName: String,
    val repoPath: String,
    val branch: String,
    val status: String,
    val summary: String,
    val updatedAt: String
)

data class TimelineItem(
    val eventId: String,
    val sessionId: String,
    val type: String,
    val title: String,
    val summary: String,
    val cursor: String?
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

data class RelayUiState(
    val relayUrl: String = RelayClient.DEFAULT_RELAY_URL,
    val pairingToken: String = "",
    val deviceToken: String = "",
    val deviceId: String = "",
    val connectionStatus: String = "Disconnected",
    val sessions: List<CodexSession> = emptyList(),
    val selectedSessionId: String? = null,
    val timeline: List<TimelineItem> = emptyList(),
    val approvals: List<ApprovalItem> = emptyList(),
    val gitSnapshots: Map<String, GitSnapshot> = emptyMap(),
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

    val activeAuthToken: String
        get() = deviceToken.ifBlank { pairingToken }
}
