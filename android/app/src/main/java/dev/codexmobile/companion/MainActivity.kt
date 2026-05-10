package dev.codexmobile.companion

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DividerDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
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
                onHealthCheck = viewModel::testConnection,
                onSessionSelected = viewModel::selectSession,
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
    onHealthCheck: () -> Unit,
    onSessionSelected: (String) -> Unit,
    onPromptSend: (String) -> Unit
) {
    MaterialTheme(
        colorScheme = MaterialTheme.colorScheme.copy(
            primary = Color(0xFF176B52),
            surface = Color(0xFFF7F8FA),
            background = Color(0xFFF7F8FA)
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
                onHealthCheck = onHealthCheck,
                onSessionSelected = onSessionSelected,
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
    onHealthCheck: () -> Unit,
    onSessionSelected: (String) -> Unit,
    onPromptSend: (String) -> Unit
) {
    var prompt by remember { mutableStateOf("总结当前进度") }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp, vertical = 18.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        Header(status = uiState.connectionStatus)
        HostSummary(
            uiState = uiState,
            onReconnect = onReconnect,
            onRelaySettingsSave = onRelaySettingsSave,
            onHealthCheck = onHealthCheck
        )
        SessionSummary(
            sessions = uiState.sessions,
            selectedSession = uiState.selectedSession,
            onSessionSelected = onSessionSelected
        )
        TimelineList(
            events = uiState.timeline.filter { it.sessionId == uiState.selectedSessionId },
            modifier = Modifier.weight(1f)
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
private fun Header(status: String) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column {
            Text(
                text = "Codex Companion",
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.SemiBold
            )
            Text(
                text = "Session control window",
                style = MaterialTheme.typography.bodyMedium,
                color = Color(0xFF5E6978)
            )
        }
        StatusPill(text = status)
    }
}

@Composable
private fun HostSummary(
    uiState: RelayUiState,
    onReconnect: () -> Unit,
    onRelaySettingsSave: (String, String) -> Unit,
    onHealthCheck: () -> Unit
) {
    var relayUrlDraft by remember(uiState.relayUrl) { mutableStateOf(uiState.relayUrl) }
    var devTokenDraft by remember(uiState.devToken) { mutableStateOf(uiState.devToken) }

    Panel {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text("Relay connection", fontWeight = FontWeight.SemiBold)
                    Text(
                        text = diagnosticsSummary(uiState),
                        style = MaterialTheme.typography.bodySmall,
                        color = Color(0xFF5E6978),
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis
                    )
                }
                StatusPill(text = uiState.connectionStatus)
            }
            TextField(
                modifier = Modifier.fillMaxWidth(),
                value = relayUrlDraft,
                onValueChange = { relayUrlDraft = it },
                singleLine = true
            )
            TextField(
                modifier = Modifier.fillMaxWidth(),
                value = devTokenDraft,
                onValueChange = { devTokenDraft = it },
                singleLine = true,
                label = { Text("Dev token") },
                visualTransformation = PasswordVisualTransformation()
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Button(
                    onClick = { onRelaySettingsSave(relayUrlDraft, devTokenDraft) },
                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF176B52))
                ) {
                    Text("Save")
                }
                OutlinedButton(onClick = onReconnect) {
                    Text(if (uiState.connectionStatus == "Online") "Refresh" else "Connect")
                }
                OutlinedButton(onClick = onHealthCheck) {
                    Text("Test")
                }
            }
            if (!uiState.lastHealthCheck.isNullOrBlank()) {
                Text(
                    text = uiState.lastHealthCheck,
                    style = MaterialTheme.typography.bodySmall,
                    color = Color(0xFF176B52),
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis
                )
            }
            if (!uiState.lastError.isNullOrBlank()) {
                Text(
                    text = uiState.lastError,
                    style = MaterialTheme.typography.bodySmall,
                    color = Color(0xFFB42318),
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis
                )
            }
        }
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
            Text("Sessions", fontWeight = FontWeight.SemiBold)
            if (sessions.isEmpty()) {
                Text(
                    text = "No sessions yet. Start Relay and Host Bridge, then reconnect.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = Color(0xFF5E6978)
                )
            } else {
                sessions.take(4).forEach { session ->
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
        color = if (selected) Color(0xFFE8F7F0) else Color(0xFFF7F8FA),
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
                StatusPill(text = session.status)
            }
            Text(
                text = session.summary.ifBlank { session.repoPath },
                style = MaterialTheme.typography.bodySmall,
                color = Color(0xFF5E6978),
                maxLines = 2,
                overflow = TextOverflow.Ellipsis
            )
        }
    }
}

@Composable
private fun TimelineList(events: List<TimelineItem>, modifier: Modifier = Modifier) {
    Panel(modifier = modifier) {
        Column(modifier = Modifier.fillMaxSize()) {
            Text("Timeline", fontWeight = FontWeight.SemiBold)
            Spacer(modifier = Modifier.height(8.dp))
            if (events.isEmpty()) {
                Text(
                    text = "No timeline events for the selected session yet.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = Color(0xFF5E6978)
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
                .background(Color(0xFF176B52))
        )
        Column(modifier = Modifier.weight(1f)) {
            Text(item.title, fontWeight = FontWeight.Medium)
            Text(
                text = item.summary,
                style = MaterialTheme.typography.bodySmall,
                color = Color(0xFF5E6978)
            )
            Text(
                text = item.type,
                style = MaterialTheme.typography.labelSmall,
                color = Color(0xFF8A94A6)
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
            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF176B52))
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
        color = Color.White,
        tonalElevation = 1.dp,
        shadowElevation = 0.dp
    ) {
        Box(modifier = Modifier.padding(14.dp)) {
            content()
        }
    }
}

@Composable
private fun StatusPill(text: String) {
    Surface(
        shape = RoundedCornerShape(99.dp),
        color = Color(0xFFE8F7F0)
    ) {
        Text(
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
            text = text,
            style = MaterialTheme.typography.labelMedium,
            color = Color(0xFF176B52),
            fontWeight = FontWeight.Medium
        )
    }
}

private fun diagnosticsSummary(uiState: RelayUiState): String {
    val connectedAt = uiState.lastConnectedAt ?: "never"
    val selected = uiState.selectedSession?.projectName ?: "none"
    return "sessions=${uiState.sessions.size}, events=${uiState.timeline.size}, selected=$selected, last connected=$connectedAt"
}
