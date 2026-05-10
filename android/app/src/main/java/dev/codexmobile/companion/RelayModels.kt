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
    val lastConnectedAt: String? = null,
    val lastHealthCheck: String? = null,
    val lastError: String? = null
) {
    val selectedSession: CodexSession?
        get() = sessions.firstOrNull { it.sessionId == selectedSessionId }

    val pendingApprovals: List<ApprovalItem>
        get() = approvals.filter { it.status == "pending" }

    val activeAuthToken: String
        get() = deviceToken.ifBlank { pairingToken }
}
