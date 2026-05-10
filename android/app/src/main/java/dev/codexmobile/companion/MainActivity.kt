package dev.codexmobile.companion

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DividerDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.ui.window.Dialog
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

class MainActivity : ComponentActivity() {
    private val viewModel by viewModels<RelayViewModel> {
        RelayViewModelFactory(this)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            val uiState by viewModel.uiState.collectAsState()

            LaunchedEffect(Unit) {
                viewModel.connect()
            }

            CompanionApp(
                uiState = uiState,
                onReconnect = viewModel::connect,
                onRelaySettingsSave = viewModel::saveRelaySettings,
                onPairingCodeApply = viewModel::applyPairingCode,
                onPairDevice = viewModel::pairDevice,
                onHealthCheck = viewModel::testConnection,
                onSessionSelected = viewModel::selectSession,
                onGitStatus = viewModel::requestGitStatus,
                onGitDiff = viewModel::requestGitDiff,
                onGitFileDiff = viewModel::requestGitFileDiff,
                onGitCommit = viewModel::requestGitCommit,
                onGitPush = viewModel::requestGitPush,
                onGitAuditRefresh = viewModel::requestGitAudit,
                onApprovalDecision = viewModel::decideApproval,
                onPromptSend = viewModel::sendPrompt
            )
        }
    }
}

@Composable
private fun CompanionApp(
    uiState: RelayUiState,
    onReconnect: () -> Unit,
    onRelaySettingsSave: (String, String) -> Unit,
    onPairingCodeApply: (String) -> Unit,
    onPairDevice: () -> Unit,
    onHealthCheck: () -> Unit,
    onSessionSelected: (String) -> Unit,
    onGitStatus: () -> Unit,
    onGitDiff: () -> Unit,
    onGitFileDiff: (String) -> Unit,
    onGitCommit: (String, String) -> Unit,
    onGitPush: () -> Unit,
    onGitAuditRefresh: () -> Unit,
    onApprovalDecision: (String, String) -> Unit,
    onPromptSend: (String) -> Unit
) {
    MaterialTheme(
        colorScheme = MaterialTheme.colorScheme.copy(
            primary = AppGreen,
            surface = PanelWhite,
            background = AppCanvas
        )
    ) {
        Surface(
            modifier = Modifier.fillMaxSize(),
            color = MaterialTheme.colorScheme.background
        ) {
            SessionDashboard(
                uiState = uiState,
                onReconnect = onReconnect,
                onRelaySettingsSave = onRelaySettingsSave,
                onPairingCodeApply = onPairingCodeApply,
                onPairDevice = onPairDevice,
                onHealthCheck = onHealthCheck,
                onSessionSelected = onSessionSelected,
                onGitStatus = onGitStatus,
                onGitDiff = onGitDiff,
                onGitFileDiff = onGitFileDiff,
                onGitCommit = onGitCommit,
                onGitPush = onGitPush,
                onGitAuditRefresh = onGitAuditRefresh,
                onApprovalDecision = onApprovalDecision,
                onPromptSend = onPromptSend
            )
        }
    }
}

@Composable
private fun SessionDashboard(
    uiState: RelayUiState,
    onReconnect: () -> Unit,
    onRelaySettingsSave: (String, String) -> Unit,
    onPairingCodeApply: (String) -> Unit,
    onPairDevice: () -> Unit,
    onHealthCheck: () -> Unit,
    onSessionSelected: (String) -> Unit,
    onGitStatus: () -> Unit,
    onGitDiff: () -> Unit,
    onGitFileDiff: (String) -> Unit,
    onGitCommit: (String, String) -> Unit,
    onGitPush: () -> Unit,
    onGitAuditRefresh: () -> Unit,
    onApprovalDecision: (String, String) -> Unit,
    onPromptSend: (String) -> Unit
) {
    var prompt by remember { mutableStateOf("\u603b\u7ed3\u5f53\u524d\u8fdb\u5ea6") }
    val scrollState = rememberScrollState()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(scrollState)
            .padding(horizontal = 16.dp, vertical = 18.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        Header(uiState = uiState)
        HostSummary(
            uiState = uiState,
            onReconnect = onReconnect,
            onRelaySettingsSave = onRelaySettingsSave,
            onPairingCodeApply = onPairingCodeApply,
            onPairDevice = onPairDevice,
            onHealthCheck = onHealthCheck
        )
        SessionSummary(
            sessions = uiState.sessions,
            selectedSession = uiState.selectedSession,
            onSessionSelected = onSessionSelected
        )
        GitPanel(
            selectedSession = uiState.selectedSession,
            snapshot = uiState.selectedGitSnapshot,
            auditEvents = uiState.selectedGitAudit,
            connectionStatus = uiState.connectionStatus,
            onStatus = onGitStatus,
            onDiff = onGitDiff,
            onFileDiff = onGitFileDiff,
            onCommit = onGitCommit,
            onPush = onGitPush,
            onAuditRefresh = onGitAuditRefresh
        )
        ApprovalInbox(
            approvals = uiState.pendingApprovals,
            selectedSessionId = uiState.selectedSessionId,
            onDecision = onApprovalDecision
        )
        TimelineList(
            events = uiState.timeline.filter { it.sessionId == uiState.selectedSessionId },
            modifier = Modifier.heightIn(min = 220.dp, max = 360.dp)
        )
        PromptComposer(
            value = prompt,
            enabled = uiState.selectedSessionId != null && uiState.connectionStatus == "Online",
            onValueChange = { prompt = it },
            onSend = {
                onPromptSend(prompt)
                prompt = ""
            }
        )
    }
}

@Composable
private fun Header(uiState: RelayUiState) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(8.dp),
        color = Ink,
        shadowElevation = 0.dp
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = "Codex Companion",
                        style = MaterialTheme.typography.headlineSmall,
                        fontWeight = FontWeight.SemiBold,
                        color = Color.White
                    )
                    Text(
                        text = uiState.selectedSession?.projectName ?: "Session control window",
                        style = MaterialTheme.typography.bodyMedium,
                        color = Color(0xFFB7C3CF),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                }
                StatusPill(text = uiState.connectionStatus, tone = statusTone(uiState.connectionStatus))
            }
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                StatChip(modifier = Modifier.weight(1f), label = "Sessions", value = uiState.sessions.size.toString())
                StatChip(modifier = Modifier.weight(1f), label = "Approvals", value = uiState.pendingApprovals.size.toString())
                StatChip(modifier = Modifier.weight(1f), label = "Audit", value = uiState.selectedGitAudit.size.toString())
            }
        }
    }
}

@Composable
private fun HostSummary(
    uiState: RelayUiState,
    onReconnect: () -> Unit,
    onRelaySettingsSave: (String, String) -> Unit,
    onPairingCodeApply: (String) -> Unit,
    onPairDevice: () -> Unit,
    onHealthCheck: () -> Unit
) {
    var relayUrlDraft by remember(uiState.relayUrl) { mutableStateOf(uiState.relayUrl) }
    var pairingTokenDraft by remember(uiState.pairingToken) { mutableStateOf(uiState.pairingToken) }
    var pairingCodeDraft by remember { mutableStateOf("") }

    Panel {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    SectionTitle("Relay connection")
                    Text(
                        text = diagnosticsSummary(uiState),
                        style = MaterialTheme.typography.bodySmall,
                        color = MutedText,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis
                    )
                }
                StatusPill(text = uiState.connectionStatus, tone = statusTone(uiState.connectionStatus))
            }
            TextField(
                modifier = Modifier.fillMaxWidth(),
                value = pairingCodeDraft,
                onValueChange = { pairingCodeDraft = it },
                singleLine = true,
                label = { Text("Pairing code") }
            )
            Button(
                modifier = Modifier.fillMaxWidth(),
                enabled = pairingCodeDraft.isNotBlank(),
                onClick = { onPairingCodeApply(pairingCodeDraft) },
                colors = ButtonDefaults.buttonColors(containerColor = Ink)
            ) {
                Text("Use code")
            }
            TextField(
                modifier = Modifier.fillMaxWidth(),
                value = relayUrlDraft,
                onValueChange = { relayUrlDraft = it },
                singleLine = true,
                label = { Text("Relay URL") }
            )
            TextField(
                modifier = Modifier.fillMaxWidth(),
                value = pairingTokenDraft,
                onValueChange = { pairingTokenDraft = it },
                singleLine = true,
                label = { Text("Pairing token") },
                visualTransformation = PasswordVisualTransformation()
            )
            InlineNotice(
                text = if (uiState.deviceToken.isNotBlank()) {
                    "Paired device ${uiState.deviceId.take(8)}"
                } else {
                    "Not paired"
                },
                tone = if (uiState.deviceToken.isNotBlank()) NoticeTone.Positive else NoticeTone.Neutral
            )
            RelayActionButtons(
                connectionStatus = uiState.connectionStatus,
                onSave = { onRelaySettingsSave(relayUrlDraft, pairingTokenDraft) },
                onPairDevice = onPairDevice,
                onReconnect = onReconnect,
                onHealthCheck = onHealthCheck
            )
            if (!uiState.lastHealthCheck.isNullOrBlank()) {
                Text(
                    text = uiState.lastHealthCheck,
                    style = MaterialTheme.typography.bodySmall,
                    color = AppGreen,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis
                )
            }
            if (!uiState.lastError.isNullOrBlank()) {
                Text(
                    text = uiState.lastError,
                    style = MaterialTheme.typography.bodySmall,
                    color = Danger,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis
                )
            }
        }
    }
}

@Composable
private fun RelayActionButtons(
    connectionStatus: String,
    onSave: () -> Unit,
    onPairDevice: () -> Unit,
    onReconnect: () -> Unit,
    onHealthCheck: () -> Unit
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Button(
                modifier = Modifier
                    .weight(1f)
                    .heightIn(min = 44.dp),
                onClick = onSave,
                colors = ButtonDefaults.buttonColors(containerColor = AppGreen)
            ) {
                Text("Save", maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            CompactActionButton(
                modifier = Modifier.weight(1f),
                text = "Pair",
                onClick = onPairDevice
            )
        }
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            CompactActionButton(
                modifier = Modifier.weight(1f),
                text = if (connectionStatus == "Online") "Refresh" else "Connect",
                onClick = onReconnect
            )
            CompactActionButton(
                modifier = Modifier.weight(1f),
                text = "Test",
                onClick = onHealthCheck
            )
        }
    }
}

@Composable
private fun CompactActionButton(modifier: Modifier = Modifier, text: String, onClick: () -> Unit) {
    OutlinedButton(
        modifier = modifier.heightIn(min = 44.dp),
        onClick = onClick,
        contentPadding = ButtonDefaults.ContentPadding
    ) {
        Text(text, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun SessionSummary(
    sessions: List<CodexSession>,
    selectedSession: CodexSession?,
    onSessionSelected: (String) -> Unit
) {
    Panel {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            SectionTitle("Sessions")
            if (sessions.isEmpty()) {
                Text(
                    text = "No sessions yet. Start Relay and Host Bridge, then reconnect.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MutedText
                )
            } else {
                sessions.forEach { session ->
                    SessionRow(
                        session = session,
                        selected = session.sessionId == selectedSession?.sessionId,
                        onClick = { onSessionSelected(session.sessionId) }
                    )
                }
            }
        }
    }
}

@Composable
private fun SessionRow(session: CodexSession, selected: Boolean, onClick: () -> Unit) {
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .clickable(onClick = onClick),
        color = if (selected) SoftGreen else SoftPanel,
        shape = RoundedCornerShape(8.dp)
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(3.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = session.projectName,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f)
                )
                StatusPill(text = session.status, tone = statusTone(session.status))
            }
            Text(
                text = session.summary.ifBlank { session.repoPath },
                style = MaterialTheme.typography.bodySmall,
                color = MutedText,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis
            )
        }
    }
}

@Composable
private fun GitPanel(
    selectedSession: CodexSession?,
    snapshot: GitSnapshot?,
    auditEvents: List<GitAuditItem>,
    connectionStatus: String,
    onStatus: () -> Unit,
    onDiff: () -> Unit,
    onFileDiff: (String) -> Unit,
    onCommit: (String, String) -> Unit,
    onPush: () -> Unit,
    onAuditRefresh: () -> Unit
) {
    var commitMessage by remember { mutableStateOf("") }
    var commitStrategy by remember { mutableStateOf("tracked_only") }
    var confirmCommit by remember { mutableStateOf(false) }
    var confirmPush by remember { mutableStateOf(false) }
    val canCommit = snapshot?.files?.isNotEmpty() == true && connectionStatus == "Online"
    val canPush = snapshot != null && snapshot.files.isEmpty() && connectionStatus == "Online"

    Panel {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    SectionTitle("Git")
                    Text(
                        text = gitSummary(selectedSession, snapshot),
                        style = MaterialTheme.typography.bodySmall,
                        color = MutedText,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis
                    )
                }
                StatusPill(text = snapshot?.branch ?: selectedSession?.branch ?: "unknown", tone = NoticeTone.Neutral)
            }
            if (snapshot != null) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    MetricTile(modifier = Modifier.weight(1f), label = "Changed", value = snapshot.files.size.toString())
                    MetricTile(modifier = Modifier.weight(1f), label = "Tracked", value = snapshot.trackedFileCount.toString())
                    MetricTile(modifier = Modifier.weight(1f), label = "New", value = snapshot.untrackedFileCount.toString())
                }
                InlineNotice(
                    text = snapshot.statusSummary.ifBlank { "clean" },
                    tone = if (snapshot.files.isEmpty()) NoticeTone.Positive else NoticeTone.Warning
                )
                if (snapshot.diffStat.isNotBlank()) {
                    Text(
                        text = snapshot.diffStat,
                        style = MaterialTheme.typography.bodySmall,
                        color = MutedText,
                        maxLines = 3,
                        overflow = TextOverflow.Ellipsis
                    )
                }
                if (snapshot.files.isNotEmpty()) {
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        snapshot.files.take(6).forEach { file ->
                            GitFileRow(
                                file = file,
                                selected = file.path == snapshot.selectedFilePath,
                                onClick = { onFileDiff(file.path) }
                            )
                        }
                    }
                }
                if (snapshot.selectedFilePath.isNotBlank()) {
                    DiffPreview(snapshot = snapshot)
                }
                if (snapshot.resultMessage.isNotBlank()) {
                    Text(
                        text = snapshot.resultMessage,
                        style = MaterialTheme.typography.bodySmall,
                        color = if (snapshot.resultOk == false) Danger else AppGreen,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis
                    )
                }
                if (snapshot.error.isNotBlank()) {
                    Text(
                        text = snapshot.error,
                        style = MaterialTheme.typography.bodySmall,
                        color = Danger,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis
                    )
                }
            }
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                CompactActionButton(
                    modifier = Modifier.weight(1f),
                    text = "Status",
                    onClick = onStatus
                )
                CompactActionButton(
                    modifier = Modifier.weight(1f),
                    text = "Diff",
                    onClick = onDiff
                )
            }
            TextField(
                modifier = Modifier.fillMaxWidth(),
                value = commitMessage,
                onValueChange = { commitMessage = it },
                enabled = canCommit,
                singleLine = true,
                label = { Text("Commit message") }
            )
            if ((snapshot?.untrackedFileCount ?: 0) > 0) {
                CommitStrategySelector(
                    selected = commitStrategy,
                    onSelected = { commitStrategy = it }
                )
            }
            Button(
                modifier = Modifier.fillMaxWidth(),
                enabled = canCommit && commitMessage.isNotBlank(),
                onClick = { confirmCommit = true },
                colors = ButtonDefaults.buttonColors(containerColor = AppGreen)
            ) {
                Text("Commit")
            }
            OutlinedButton(
                modifier = Modifier.fillMaxWidth(),
                enabled = canPush,
                onClick = { confirmPush = true }
            ) {
                Text("Push")
            }
            if (snapshot != null && snapshot.files.isNotEmpty()) {
                Text(
                    text = "Push is available only when the worktree is clean.",
                    style = MaterialTheme.typography.bodySmall,
                    color = SubtleText,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis
                )
            }
            snapshot?.takeIf { it.untrackedFileCount > 0 }?.let { currentSnapshot ->
                Text(
                    text = commitStrategyWarning(currentSnapshot, commitStrategy),
                    style = MaterialTheme.typography.bodySmall,
                    color = if (commitStrategy == "include_untracked") AppGreen else Danger,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis
                )
            }
            if (selectedSession == null || connectionStatus != "Online") {
                Text(
                    text = "Select an online session to refresh Git status.",
                    style = MaterialTheme.typography.bodySmall,
                    color = SubtleText
                )
            }
            GitAuditPreview(
                events = auditEvents,
                enabled = selectedSession != null,
                onRefresh = onAuditRefresh
            )
        }
    }

    if (confirmCommit) {
        CommitConfirmDialog(
            changedFileCount = snapshot?.files?.size ?: 0,
            message = commitMessage,
            commitStrategy = commitStrategy,
            untrackedFileCount = snapshot?.untrackedFileCount ?: 0,
            onDismiss = { confirmCommit = false },
            onConfirm = {
                onCommit(commitMessage, commitStrategy)
                confirmCommit = false
            }
        )
    }

    if (confirmPush) {
        PushConfirmDialog(
            branch = snapshot?.branch ?: selectedSession?.branch ?: "unknown",
            onDismiss = { confirmPush = false },
            onConfirm = {
                onPush()
                confirmPush = false
            }
        )
    }
}

@Composable
private fun GitAuditPreview(
    events: List<GitAuditItem>,
    enabled: Boolean,
    onRefresh: () -> Unit
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            SectionTitle("Git audit")
            OutlinedButton(
                enabled = enabled,
                onClick = onRefresh
            ) {
                Text("Refresh")
            }
        }
        if (events.isEmpty()) {
            Text(
                text = "No audit events loaded.",
                style = MaterialTheme.typography.bodySmall,
                color = SubtleText
            )
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                events.take(5).forEach { event ->
                    GitAuditRow(event)
                }
            }
        }
    }
}

@Composable
private fun GitAuditRow(event: GitAuditItem) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(SoftPanel, RoundedCornerShape(8.dp))
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(3.dp)
    ) {
        Text(
            text = gitAuditTitle(event),
            style = MaterialTheme.typography.bodySmall,
            fontWeight = FontWeight.Medium,
            color = BodyText,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
        Text(
            text = gitAuditDetail(event),
            style = MaterialTheme.typography.labelSmall,
            color = MutedText,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis
        )
    }
}

@Composable
private fun CommitStrategySelector(
    selected: String,
    onSelected: (String) -> Unit
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        StrategyButton(
            modifier = Modifier.weight(1f),
            text = "Tracked",
            selected = selected == "tracked_only",
            onClick = { onSelected("tracked_only") }
        )
        StrategyButton(
            modifier = Modifier.weight(1f),
            text = "Include new",
            selected = selected == "include_untracked",
            onClick = { onSelected("include_untracked") }
        )
    }
}

@Composable
private fun StrategyButton(
    modifier: Modifier = Modifier,
    text: String,
    selected: Boolean,
    onClick: () -> Unit
) {
    if (selected) {
        Button(
            modifier = modifier.height(40.dp),
            onClick = onClick,
            colors = ButtonDefaults.buttonColors(containerColor = AppGreen)
        ) {
            Text(text)
        }
    } else {
        OutlinedButton(
            modifier = modifier.height(40.dp),
            onClick = onClick
        ) {
            Text(text)
        }
    }
}

@Composable
private fun CommitConfirmDialog(
    changedFileCount: Int,
    message: String,
    commitStrategy: String,
    untrackedFileCount: Int,
    onDismiss: () -> Unit,
    onConfirm: () -> Unit
) {
    Dialog(onDismissRequest = onDismiss) {
        Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(8.dp),
            color = Color.White
        ) {
            Column(
                modifier = Modifier.padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                Text("Confirm commit", fontWeight = FontWeight.SemiBold)
                Text(
                    text = commitConfirmText(changedFileCount, untrackedFileCount, commitStrategy),
                    style = MaterialTheme.typography.bodySmall,
                    color = MutedText
                )
                if (untrackedFileCount > 0) {
                    Text(
                        text = if (commitStrategy == "include_untracked") {
                            "$untrackedFileCount untracked file(s) will be staged if Host Bridge write actions are enabled."
                        } else {
                            "$untrackedFileCount untracked file(s) will not be committed by the current tracked-only strategy."
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = if (commitStrategy == "include_untracked") AppGreen else Danger
                    )
                }
                Text(
                    text = message,
                    style = MaterialTheme.typography.bodySmall,
                    color = BodyText,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis
                )
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlinedButton(
                        modifier = Modifier.weight(1f),
                        onClick = onDismiss
                    ) {
                        Text("Cancel")
                    }
                    Button(
                        modifier = Modifier.weight(1f),
                        onClick = onConfirm,
                        colors = ButtonDefaults.buttonColors(containerColor = AppGreen)
                    ) {
                        Text("Confirm")
                    }
                }
            }
        }
    }
}

@Composable
private fun PushConfirmDialog(
    branch: String,
    onDismiss: () -> Unit,
    onConfirm: () -> Unit
) {
    Dialog(onDismissRequest = onDismiss) {
        Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(8.dp),
            color = Color.White
        ) {
            Column(
                modifier = Modifier.padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                Text("Confirm push", fontWeight = FontWeight.SemiBold)
                Text(
                    text = pushConfirmText(branch),
                    style = MaterialTheme.typography.bodySmall,
                    color = MutedText
                )
                Text(
                    text = "Host Bridge will execute push only when write and push actions are explicitly enabled and host policy allows it.",
                    style = MaterialTheme.typography.bodySmall,
                    color = Danger
                )
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlinedButton(
                        modifier = Modifier.weight(1f),
                        onClick = onDismiss
                    ) {
                        Text("Cancel")
                    }
                    Button(
                        modifier = Modifier.weight(1f),
                        onClick = onConfirm,
                        colors = ButtonDefaults.buttonColors(containerColor = AppGreen)
                    ) {
                        Text("Push")
                    }
                }
            }
        }
    }
}

@Composable
private fun GitFileRow(file: GitFileChange, selected: Boolean, onClick: () -> Unit) {
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .clickable(onClick = onClick),
        color = if (selected) SoftGreen else SoftPanel,
        shape = RoundedCornerShape(8.dp)
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = gitFileStatus(file),
                style = MaterialTheme.typography.labelMedium,
                color = AppGreen,
                fontWeight = FontWeight.Medium
            )
            Text(
                text = file.path,
                modifier = Modifier.weight(1f),
                style = MaterialTheme.typography.bodySmall,
                color = BodyText,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }
    }
}

@Composable
private fun DiffPreview(snapshot: GitSnapshot) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = Ink,
        shape = RoundedCornerShape(8.dp)
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 9.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            Text(
                text = snapshot.selectedFilePath,
                style = MaterialTheme.typography.labelMedium,
                color = SoftGreen,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
            Text(
                text = snapshot.selectedFileDiff.ifBlank { "No unstaged diff for this file." },
                style = MaterialTheme.typography.bodySmall,
                color = Color(0xFFF2F4F7),
                maxLines = 12,
                overflow = TextOverflow.Ellipsis
            )
            if (snapshot.selectedFileDiffTruncated) {
                Text(
                    text = "Diff truncated",
                    style = MaterialTheme.typography.labelSmall,
                    color = Color(0xFFFDB022)
                )
            }
        }
    }
}

@Composable
private fun ApprovalInbox(
    approvals: List<ApprovalItem>,
    selectedSessionId: String?,
    onDecision: (String, String) -> Unit
) {
    val visibleApprovals = approvals
        .filter { selectedSessionId == null || it.sessionId == selectedSessionId }
        .take(3)

    if (visibleApprovals.isEmpty()) {
        return
    }

    Panel {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("Needs attention", fontWeight = FontWeight.SemiBold)
            visibleApprovals.forEach { approval ->
                ApprovalRow(approval = approval, onDecision = onDecision)
            }
        }
    }
}

@Composable
private fun ApprovalRow(
    approval: ApprovalItem,
    onDecision: (String, String) -> Unit
) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = Color(0xFFFFF8E8),
        shape = RoundedCornerShape(8.dp)
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 9.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = approval.title,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f)
                )
                StatusPill(text = approval.riskLevel)
            }
            Text(
                text = approval.summary.ifBlank { approval.kind },
                style = MaterialTheme.typography.bodySmall,
                color = MutedText,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis
            )
            if (approval.command.isNotBlank()) {
                Text(
                    text = approval.command,
                    style = MaterialTheme.typography.bodySmall,
                    color = BodyText,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Button(
                    onClick = { onDecision(approval.approvalId, "approve_once") },
                    colors = ButtonDefaults.buttonColors(containerColor = AppGreen)
                ) {
                    Text("Approve")
                }
                OutlinedButton(onClick = { onDecision(approval.approvalId, "deny") }) {
                    Text("Deny")
                }
            }
        }
    }
}

@Composable
private fun TimelineList(events: List<TimelineItem>, modifier: Modifier = Modifier) {
    Panel(modifier = modifier) {
        Column(modifier = Modifier.fillMaxSize()) {
            SectionTitle("Timeline")
            Spacer(modifier = Modifier.height(8.dp))
            if (events.isEmpty()) {
                Text(
                    text = "No timeline events for the selected session yet.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MutedText
                )
            } else {
                LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    items(events, key = { it.eventId }) { item ->
                        TimelineRow(item)
                    }
                }
            }
        }
    }
}

@Composable
private fun TimelineRow(item: TimelineItem) {
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(
            modifier = Modifier
                .padding(top = 5.dp)
                .size(9.dp)
                .clip(RoundedCornerShape(9.dp))
                .background(AppGreen)
        )
        Column(modifier = Modifier.weight(1f)) {
            Text(item.title, fontWeight = FontWeight.Medium)
            Text(
                text = item.summary,
                style = MaterialTheme.typography.bodySmall,
                color = MutedText
            )
            Text(
                text = item.type,
                style = MaterialTheme.typography.labelSmall,
                color = SubtleText
            )
            HorizontalDivider(
                modifier = Modifier.padding(top = 10.dp),
                color = DividerDefaults.color.copy(alpha = 0.6f)
            )
        }
    }
}

@Composable
private fun PromptComposer(
    value: String,
    enabled: Boolean,
    onValueChange: (String) -> Unit,
    onSend: () -> Unit
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        TextField(
            modifier = Modifier.weight(1f),
            value = value,
            onValueChange = onValueChange,
            enabled = enabled,
            singleLine = true
        )
        Button(
            enabled = enabled && value.isNotBlank(),
            onClick = onSend,
            colors = ButtonDefaults.buttonColors(containerColor = AppGreen)
        ) {
            Text("Send")
        }
    }
}

@Composable
private fun Panel(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(8.dp),
        color = PanelWhite,
        tonalElevation = 1.dp,
        shadowElevation = 0.dp
    ) {
        Box(modifier = Modifier.padding(14.dp)) {
            content()
        }
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.titleMedium,
        fontWeight = FontWeight.SemiBold,
        color = BodyText
    )
}

@Composable
private fun StatChip(modifier: Modifier = Modifier, label: String, value: String) {
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(8.dp),
        color = Color(0xFF182536)
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(2.dp)
        ) {
            Text(
                text = value,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
                color = Color.White
            )
            Text(
                text = label,
                style = MaterialTheme.typography.labelSmall,
                color = Color(0xFFB7C3CF),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }
    }
}

@Composable
private fun MetricTile(modifier: Modifier = Modifier, label: String, value: String) {
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(8.dp),
        color = SoftPanel,
        border = BorderStroke(1.dp, Color(0xFFE2E8F0))
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(2.dp)
        ) {
            Text(
                text = value,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
                color = BodyText
            )
            Text(
                text = label,
                style = MaterialTheme.typography.labelSmall,
                color = MutedText,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }
    }
}

@Composable
private fun InlineNotice(text: String, tone: NoticeTone) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(8.dp),
        color = tone.background
    ) {
        Text(
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
            text = text,
            style = MaterialTheme.typography.bodySmall,
            color = tone.foreground,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis
        )
    }
}

@Composable
private fun StatusPill(text: String, tone: NoticeTone = NoticeTone.Positive) {
    Surface(
        shape = RoundedCornerShape(99.dp),
        color = tone.background
    ) {
        Text(
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
            text = text,
            style = MaterialTheme.typography.labelMedium,
            color = tone.foreground,
            fontWeight = FontWeight.Medium
        )
    }
}

private enum class NoticeTone(val background: Color, val foreground: Color) {
    Positive(SoftGreen, AppGreen),
    Warning(Color(0xFFFFF4D6), Color(0xFF9A5B00)),
    Critical(Color(0xFFFFE7E3), Danger),
    Neutral(Color(0xFFEFF3F7), MutedText)
}

private fun statusTone(status: String): NoticeTone {
    val normalized = status.lowercase()
    return when {
        normalized == "online" || normalized == "running" || normalized == "completed" -> NoticeTone.Positive
        normalized == "connecting" || normalized == "waiting_for_input" || normalized == "idle" -> NoticeTone.Warning
        normalized == "disconnected" || normalized == "failed" || normalized == "error" -> NoticeTone.Critical
        else -> NoticeTone.Neutral
    }
}

private val AppCanvas = Color(0xFFF3F5F7)
private val PanelWhite = Color(0xFFFFFFFF)
private val SoftPanel = Color(0xFFF8FAFC)
private val Ink = Color(0xFF111927)
private val BodyText = Color(0xFF263241)
private val MutedText = Color(0xFF5C6877)
private val SubtleText = Color(0xFF8A94A6)
private val AppGreen = Color(0xFF176B52)
private val SoftGreen = Color(0xFFE6F4EF)
private val Danger = Color(0xFFB42318)

private fun diagnosticsSummary(uiState: RelayUiState): String {
    val connectedAt = uiState.lastConnectedAt ?: "never"
    val selected = uiState.selectedSession?.projectName ?: "none"
    return "sessions=${uiState.sessions.size}, approvals=${uiState.pendingApprovals.size}, events=${uiState.timeline.size}, selected=$selected, last connected=$connectedAt"
}

private fun gitSummary(selectedSession: CodexSession?, snapshot: GitSnapshot?): String {
    if (selectedSession == null) {
        return "No selected session"
    }
    if (snapshot == null) {
        return selectedSession.repoPath.ifBlank { "No Git snapshot yet" }
    }
    if (!snapshot.isGitRepo) {
        return "Not a git repo"
    }
    return snapshot.repoPath.ifBlank { selectedSession.repoPath }
}

private fun gitFileStatus(file: GitFileChange): String {
    if (!file.tracked) {
        return "??"
    }
    val index = file.indexStatus.ifBlank { "." }
    val worktree = file.worktreeStatus.ifBlank { "." }
    return "$index$worktree"
}

private fun gitChangeSummary(snapshot: GitSnapshot): String {
    val status = snapshot.statusSummary.ifBlank { "unknown" }
    return "changes=${snapshot.files.size}, tracked=${snapshot.trackedFileCount}, untracked=${snapshot.untrackedFileCount}, status=$status"
}

private fun commitConfirmText(
    changedFileCount: Int,
    untrackedFileCount: Int,
    commitStrategy: String
): String {
    val trackedCount = (changedFileCount - untrackedFileCount).coerceAtLeast(0)
    return if (commitStrategy == "include_untracked") {
        "This requests a commit for $trackedCount tracked changed file(s) plus $untrackedFileCount untracked file(s). Host Bridge will only execute it when Git write actions are explicitly enabled."
    } else {
        "This requests a tracked-only commit for $trackedCount tracked changed file(s). Host Bridge will only execute it when Git write actions are explicitly enabled."
    }
}

private fun commitStrategyWarning(snapshot: GitSnapshot, commitStrategy: String): String {
    return if (commitStrategy == "include_untracked") {
        "${snapshot.untrackedFileCount} untracked file(s) will be staged only if Host Bridge write actions are enabled."
    } else {
        "${snapshot.untrackedFileCount} untracked file(s) will not be included by the current commit strategy."
    }
}

private fun pushConfirmText(branch: String): String {
    return "This requests `git push` for branch $branch. The local worktree must be clean and the branch must have an upstream tracking branch."
}

private fun gitAuditTitle(event: GitAuditItem): String {
    val result = when (event.resultOk) {
        true -> "ok"
        false -> "blocked"
        null -> event.phase
    }
    return "${event.action} ${event.phase} $result"
}

private fun gitAuditDetail(event: GitAuditItem): String {
    val file = event.filePath.takeIf { it.isNotBlank() }?.let { " file=$it" } ?: ""
    val device = event.deviceDisplayName.ifBlank { event.deviceId }.ifBlank { "unknown device" }
    val changed = event.changedFileCount?.let { " changes=$it" } ?: ""
    return "$device$file$changed ${event.createdAt}".trim()
}
