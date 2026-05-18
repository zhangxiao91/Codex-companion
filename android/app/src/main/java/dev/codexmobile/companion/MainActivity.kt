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
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DividerDefaults
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.ui.window.Dialog
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val viewModel by viewModels<RelayViewModel> {
        RelayViewModelFactory(this)
    }
    private var scanNotice by mutableStateOf<String?>(null)

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
                onPromptSend = viewModel::sendPrompt,
                onNewChat = viewModel::createNewChat,
                onLoadEarlierTimeline = viewModel::loadEarlierTimeline,
                onScanQrCode = ::scanPairingCode,
                scanNotice = scanNotice
            )
        }
    }

    private fun scanPairingCode() {
        scanNotice = null
        val options = GmsBarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
            .enableAutoZoom()
            .build()
        GmsBarcodeScanning.getClient(this, options)
            .startScan()
            .addOnSuccessListener { barcode ->
                val raw = barcode.rawValue?.trim().orEmpty()
                if (raw.isBlank()) {
                    scanNotice = "QR code did not contain text."
                    return@addOnSuccessListener
                }
                viewModel.applyPairingCode(raw)
            }
            .addOnCanceledListener {
                scanNotice = "QR scan canceled."
            }
            .addOnFailureListener { error ->
                scanNotice = "QR scan failed: ${error.message ?: "scanner unavailable"}"
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
    onPromptSend: (String) -> Unit,
    onNewChat: () -> Unit,
    onLoadEarlierTimeline: () -> Unit,
    onScanQrCode: () -> Unit,
    scanNotice: String?
) {
    MaterialTheme(
        colorScheme = MaterialTheme.colorScheme.copy(
            primary = AccentBlue,
            surface = SheetBlack,
            background = AppBlack,
            onSurface = PrimaryText,
            onBackground = PrimaryText
        )
    ) {
        Surface(
            modifier = Modifier.fillMaxSize(),
            color = AppBlack
        ) {
            if (uiState.deviceToken.isBlank()) {
                PairingScreen(
                    uiState = uiState,
                    onRelaySettingsSave = onRelaySettingsSave,
                    onPairingCodeApply = onPairingCodeApply,
                    onPairDevice = onPairDevice,
                    onHealthCheck = onHealthCheck,
                    onScanQrCode = onScanQrCode,
                    scanNotice = scanNotice
                )
            } else {
                MainSessionScreen(
                    uiState = uiState,
                    onReconnect = onReconnect,
                    onSessionSelected = onSessionSelected,
                    onGitStatus = onGitStatus,
                    onGitDiff = onGitDiff,
                    onGitFileDiff = onGitFileDiff,
                    onGitCommit = onGitCommit,
                    onGitPush = onGitPush,
                    onGitAuditRefresh = onGitAuditRefresh,
                    onApprovalDecision = onApprovalDecision,
                    onPromptSend = onPromptSend,
                    onNewChat = onNewChat,
                    onLoadEarlierTimeline = onLoadEarlierTimeline,
                    onHealthCheck = onHealthCheck
                )
            }
        }
    }
}

@Composable
private fun PairingScreen(
    uiState: RelayUiState,
    onRelaySettingsSave: (String, String) -> Unit,
    onPairingCodeApply: (String) -> Unit,
    onPairDevice: () -> Unit,
    onHealthCheck: () -> Unit,
    onScanQrCode: () -> Unit,
    scanNotice: String?
) {
    var pairingCodeDraft by remember { mutableStateOf("") }
    var relayUrlDraft by remember(uiState.relayUrl) { mutableStateOf(uiState.relayUrl) }
    var pairingTokenDraft by remember(uiState.pairingToken) { mutableStateOf(uiState.pairingToken) }
    var mode by remember { mutableStateOf(PairingMode.Code) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .navigationBarsPadding()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 24.dp, vertical = 28.dp),
        verticalArrangement = Arrangement.spacedBy(26.dp)
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                text = "Codex Companion",
                style = MaterialTheme.typography.headlineMedium,
                fontWeight = FontWeight.SemiBold,
                color = PrimaryText
            )
            Text(
                text = "Pair this phone with a trusted Codex host.",
                style = MaterialTheme.typography.bodyLarge,
                color = SecondaryText
            )
        }

        Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(28.dp),
            color = CardBlack,
            border = BorderStroke(1.dp, StrokeDark)
        ) {
            Column(
                modifier = Modifier.padding(20.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp)
            ) {
                Text("Scan desktop QR", color = PrimaryText, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
                Text(
                    text = "Run dev:pair or server:pairing-code, then scan the QR shown on your computer.",
                    color = SecondaryText,
                    style = MaterialTheme.typography.bodyMedium
                )
                Button(
                    modifier = Modifier.fillMaxWidth().height(54.dp),
                    shape = RoundedCornerShape(99.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = AccentBlue),
                    onClick = onScanQrCode
                ) {
                    Text("Scan QR code", fontWeight = FontWeight.SemiBold)
                }
                if (!scanNotice.isNullOrBlank()) {
                    InlineNotice(
                        text = scanNotice,
                        tone = if (scanNotice.contains("failed", ignoreCase = true) || scanNotice.contains("did not", ignoreCase = true)) NoticeTone.Critical else NoticeTone.Warning
                    )
                }
            }
        }

        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            DarkToggleChip("Pairing code", mode == PairingMode.Code) { mode = PairingMode.Code }
            DarkToggleChip("Manual config", mode == PairingMode.Manual) { mode = PairingMode.Manual }
        }

        if (mode == PairingMode.Code) {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                DarkTextField(
                    value = pairingCodeDraft,
                    onValueChange = { pairingCodeDraft = it },
                    label = "Pairing code",
                    singleLine = false,
                    minHeight = 112.dp
                )
                Button(
                    modifier = Modifier.fillMaxWidth().height(52.dp),
                    enabled = pairingCodeDraft.isNotBlank(),
                    shape = RoundedCornerShape(99.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = PrimaryText, contentColor = AppBlack),
                    onClick = { onPairingCodeApply(pairingCodeDraft) }
                ) {
                    Text("Use pairing code", fontWeight = FontWeight.SemiBold)
                }
            }
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                DarkTextField(relayUrlDraft, { relayUrlDraft = it }, "Relay URL")
                DarkTextField(pairingTokenDraft, { pairingTokenDraft = it }, "Pairing token", password = true)
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Button(
                        modifier = Modifier.weight(1f).height(50.dp),
                        shape = RoundedCornerShape(99.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = PrimaryText, contentColor = AppBlack),
                        onClick = { onRelaySettingsSave(relayUrlDraft, pairingTokenDraft) }
                    ) {
                        Text("Save")
                    }
                    OutlinedButton(
                        modifier = Modifier.weight(1f).height(50.dp),
                        shape = RoundedCornerShape(99.dp),
                        border = BorderStroke(1.dp, StrokeDark),
                        onClick = onPairDevice
                    ) {
                        Text("Pair", color = PrimaryText)
                    }
                }
                TextButton(onClick = onHealthCheck) {
                    Text("Test connection", color = SecondaryText)
                }
            }
        }

        PairingStatusBlock(uiState = uiState)
    }
}

@Composable
private fun PairingStatusBlock(uiState: RelayUiState) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(uiState.connectionStatus, color = SecondaryText, style = MaterialTheme.typography.bodySmall)
            Text(if (uiState.deviceId.isBlank()) "Not paired" else "Device ${uiState.deviceId.take(8)}", color = TertiaryText, style = MaterialTheme.typography.bodySmall)
        }
        if (!uiState.lastHealthCheck.isNullOrBlank()) {
            InlineNotice(text = uiState.lastHealthCheck, tone = NoticeTone.Positive)
        }
        if (!uiState.lastError.isNullOrBlank()) {
            InlineNotice(text = uiState.lastError, tone = NoticeTone.Critical)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MainSessionScreen(
    uiState: RelayUiState,
    onReconnect: () -> Unit,
    onSessionSelected: (String) -> Unit,
    onGitStatus: () -> Unit,
    onGitDiff: () -> Unit,
    onGitFileDiff: (String) -> Unit,
    onGitCommit: (String, String) -> Unit,
    onGitPush: () -> Unit,
    onGitAuditRefresh: () -> Unit,
    onApprovalDecision: (String, String) -> Unit,
    onPromptSend: (String) -> Unit,
    onNewChat: () -> Unit,
    onLoadEarlierTimeline: () -> Unit,
    onHealthCheck: () -> Unit
) {
    val drawerState = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    var toolsOpen by remember { mutableStateOf(false) }

    ModalNavigationDrawer(
        drawerState = drawerState,
        drawerContent = {
            SessionDrawer(
                uiState = uiState,
                onSessionSelected = { sessionId ->
                    onSessionSelected(sessionId)
                    scope.launch { drawerState.close() }
                },
                onNewChat = {
                    onNewChat()
                    scope.launch { drawerState.close() }
                },
                onReconnect = onReconnect
            )
        }
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .statusBarsPadding()
                .navigationBarsPadding()
                .imePadding()
                .padding(horizontal = 18.dp, vertical = 18.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            MainTopBar(
                uiState = uiState,
                onMenu = { scope.launch { drawerState.open() } },
                onTools = { toolsOpen = true },
                onNewChat = onNewChat,
                onReconnect = onReconnect
            )
            TimelineStream(uiState = uiState, modifier = Modifier.weight(1f), onLoadEarlier = onLoadEarlierTimeline)
            ChatComposer(
                selectedSession = uiState.selectedSession,
                online = uiState.connectionStatus == "Online",
                onPromptSend = onPromptSend
            )
        }
    }

    if (toolsOpen) {
        ModalBottomSheet(
            onDismissRequest = { toolsOpen = false },
            containerColor = SheetBlack,
            contentColor = PrimaryText,
            dragHandle = null
        ) {
            Column(
                modifier = Modifier
                    .navigationBarsPadding()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 18.dp, vertical = 20.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp)
            ) {
                Text("Session tools", color = PrimaryText, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                ConnectionToolCard(uiState = uiState, onReconnect = onReconnect, onHealthCheck = onHealthCheck)
                ApprovalInbox(uiState.pendingApprovals, uiState.selectedSessionId, onApprovalDecision)
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
            }
        }
    }
}

@Composable
private fun MainTopBar(uiState: RelayUiState, onMenu: () -> Unit, onTools: () -> Unit, onNewChat: () -> Unit, onReconnect: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Row(modifier = Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            CircleTextButton(text = "≡", onClick = onMenu)
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = uiState.selectedSession?.projectName ?: "Codex",
                    color = PrimaryText,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                Text(
                    text = uiState.selectedSession?.let { "${it.branch} · ${it.status}" } ?: "${uiState.sessions.size} live sessions",
                    color = SecondaryText,
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            CircleTextButton(text = "+", onClick = onNewChat)
            StatusOrb(uiState.connectionStatus, onReconnect)
            CircleTextButton(text = "...", onClick = onTools)
        }
    }
}

@Composable
private fun SessionDrawer(uiState: RelayUiState, onSessionSelected: (String) -> Unit, onNewChat: () -> Unit, onReconnect: () -> Unit) {
    ModalDrawerSheet(
        modifier = Modifier.fillMaxHeight().width(328.dp),
        drawerContainerColor = AppBlack,
        drawerContentColor = PrimaryText
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .statusBarsPadding()
                .navigationBarsPadding()
                .padding(horizontal = 22.dp, vertical = 24.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp)
        ) {
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Text("Codex", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
                StatusPill(uiState.connectionStatus, statusTone(uiState.connectionStatus))
            }
            DrawerShortcut("Projects", "${uiState.sessions.map { it.hostId }.distinct().size} hosts")
            DrawerShortcut("Approvals", "${uiState.pendingApprovals.size} pending")
            DrawerShortcut("Git", uiState.selectedGitSnapshot?.branch ?: "No snapshot")
            Button(
                modifier = Modifier.fillMaxWidth().height(48.dp),
                enabled = uiState.connectionStatus == "Online" && uiState.sessions.isNotEmpty(),
                shape = RoundedCornerShape(99.dp),
                colors = ButtonDefaults.buttonColors(containerColor = PrimaryText, contentColor = AppBlack),
                onClick = onNewChat
            ) {
                Text("New Chat", fontWeight = FontWeight.SemiBold)
            }
            Text("Recents", color = PrimaryText, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.titleMedium)
            if (uiState.sessions.isEmpty()) {
                Text("No live sessions. Keep Host Bridge online, then refresh.", color = SecondaryText)
                OutlinedButton(onClick = onReconnect, border = BorderStroke(1.dp, StrokeDark)) {
                    Text("Reconnect", color = PrimaryText)
                }
            } else {
                LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(uiState.sessions, key = { it.sessionId }) { session ->
                        DrawerSessionRow(session, session.sessionId == uiState.selectedSessionId) {
                            onSessionSelected(session.sessionId)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun DrawerShortcut(text: String, detail: String) {
    Row(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("•", color = PrimaryText, style = MaterialTheme.typography.headlineSmall)
        Column {
            Text(text, color = PrimaryText, style = MaterialTheme.typography.titleMedium)
            Text(detail, color = SecondaryText, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
private fun DrawerSessionRow(session: CodexSession, selected: Boolean, onClick: () -> Unit) {
    Surface(
        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).clickable(onClick = onClick),
        color = if (selected) CardBlack else Color.Transparent,
        shape = RoundedCornerShape(14.dp),
        border = if (selected) BorderStroke(1.dp, StrokeDark) else null
    ) {
        Column(modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(session.projectName, color = PrimaryText, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("${session.branch} · ${session.status}", color = SecondaryText, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("Updated ${formatMetaTime(session.updatedAt)}", color = TertiaryText, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(session.hostId, color = TertiaryText, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
private fun TimelineStream(uiState: RelayUiState, modifier: Modifier = Modifier, onLoadEarlier: () -> Unit) {
    val selectedSession = uiState.selectedSession
    val events = uiState.timeline.filter { it.sessionId == uiState.selectedSessionId }
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val expandedOperationGroups = remember(selectedSession?.sessionId) { mutableStateMapOf<String, Boolean>() }
    val displayItems = remember(events) { buildTimelineDisplayItems(events) }
    val hasMoreEarlier = uiState.selectedSessionId?.let { uiState.timelineHasMoreEarlier[it] } != false

    LaunchedEffect(selectedSession?.sessionId, displayItems.size, hasMoreEarlier, uiState.timelineLoadingEarlier) {
        if (selectedSession == null || displayItems.isEmpty() || !hasMoreEarlier || uiState.timelineLoadingEarlier) {
            return@LaunchedEffect
        }

        snapshotFlow {
            val layoutInfo = listState.layoutInfo
            val oldestVisibleIndex = layoutInfo.visibleItemsInfo.maxOfOrNull { it.index } ?: 0
            oldestVisibleIndex >= displayItems.size - 3
        }
            .distinctUntilChanged()
            .collect { nearOldest ->
                if (nearOldest) {
                    onLoadEarlier()
                }
            }
    }

    Box(modifier = modifier.fillMaxWidth()) {
        if (selectedSession == null) {
            EmptyMainState(
                title = if (uiState.sessions.isEmpty()) "Waiting for Codex" else "Choose a session",
                body = if (uiState.sessions.isEmpty()) "Live sessions from your connected host will appear here." else "Open the drawer and pick a recent session."
            )
        } else if (events.isEmpty()) {
            EmptyMainState(selectedSession.projectName, selectedSession.summary.ifBlank { "No timeline events yet." })
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                state = listState,
                verticalArrangement = Arrangement.spacedBy(14.dp),
                reverseLayout = true
            ) {
                items(displayItems, key = { it.stableKey }) { item ->
                    when (item) {
                        is TimelineDisplayItem.Event -> TimelineBubble(item.event)
                        is TimelineDisplayItem.TurnGroup -> TimelineTurnGroup(
                            group = item,
                            expanded = expandedOperationGroups[item.groupId] == true,
                            onToggle = {
                                expandedOperationGroups[item.groupId] = expandedOperationGroups[item.groupId] != true
                            }
                        )
                    }
                }
                item(key = "load-earlier") {
                    TimelineHistoryControl(
                        loading = uiState.timelineLoadingEarlier,
                        hasMore = hasMoreEarlier,
                        onLoadEarlier = onLoadEarlier
                    )
                }
            }
            if (events.size > 4 && listState.firstVisibleItemIndex > 0) {
                Surface(
                    modifier = Modifier
                        .align(Alignment.BottomEnd)
                        .padding(end = 8.dp, bottom = 10.dp)
                        .size(46.dp)
                        .clip(RoundedCornerShape(99.dp))
                        .clickable { scope.launch { listState.animateScrollToItem(0) } },
                    shape = RoundedCornerShape(99.dp),
                    color = PrimaryText,
                    shadowElevation = 6.dp
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        Text("↓", color = AppBlack, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                    }
                }
            }
        }
    }
}

@Composable
private fun EmptyMainState(title: String, body: String) {
    Column(
        modifier = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text(title, color = PrimaryText, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
        Spacer(modifier = Modifier.height(10.dp))
        Text(body, color = SecondaryText, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun TimelineHistoryControl(loading: Boolean, hasMore: Boolean, onLoadEarlier: () -> Unit) {
    if (!hasMore) {
        Text(
            modifier = Modifier.fillMaxWidth().padding(vertical = 10.dp),
            text = "Beginning of cached history",
            color = TertiaryText,
            style = MaterialTheme.typography.labelMedium
        )
        return
    }

    OutlinedButton(
        modifier = Modifier.fillMaxWidth(),
        enabled = !loading,
        onClick = onLoadEarlier,
        border = BorderStroke(1.dp, StrokeDark),
        shape = RoundedCornerShape(99.dp)
    ) {
        Text(if (loading) "Loading earlier..." else "Load earlier", color = PrimaryText)
    }
}

@Composable
private fun TimelineBubble(event: TimelineItem) {
    val isUser = event.title.contains("prompt", ignoreCase = true) || event.type.contains("user", ignoreCase = true)
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start) {
        Surface(
            modifier = Modifier.fillMaxWidth(if (isUser) 0.82f else 0.9f),
            shape = RoundedCornerShape(22.dp),
            color = if (isUser) AccentBlue else CardBlack,
            border = if (isUser) null else BorderStroke(1.dp, StrokeDark)
        ) {
            Column(modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(event.title, color = PrimaryText, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(event.summary, color = if (isUser) PrimaryText.copy(alpha = 0.92f) else SecondaryText, style = MaterialTheme.typography.bodyMedium)
                Text(
                    text = "${event.type} · ${formatMetaTime(event.createdAt)}",
                    color = if (isUser) PrimaryText.copy(alpha = 0.65f) else TertiaryText,
                    style = MaterialTheme.typography.labelSmall
                )
            }
        }
    }
}

@Composable
private fun TimelineTurnGroup(
    group: TimelineDisplayItem.TurnGroup,
    expanded: Boolean,
    onToggle: () -> Unit
) {
    Surface(
        modifier = Modifier
            .fillMaxWidth(0.92f)
            .clip(RoundedCornerShape(18.dp))
            .clickable(onClick = onToggle),
        shape = RoundedCornerShape(18.dp),
        color = CardBlack.copy(alpha = 0.72f),
        border = BorderStroke(1.dp, StrokeDark)
    ) {
        Column(modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Column(modifier = Modifier.weight(1f)) {
                    Text("Codex response", color = PrimaryText, fontWeight = FontWeight.SemiBold)
                    Text(
                        text = "${group.events.size} event(s) - ${formatMetaTime(group.latestCreatedAt)}",
                        color = TertiaryText,
                        style = MaterialTheme.typography.labelSmall,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                }
                Text(if (expanded) "Hide" else "Show", color = SecondaryText, style = MaterialTheme.typography.labelMedium)
            }
            if (!expanded) {
                Text(
                    text = compactTurnSummary(group.events),
                    color = SecondaryText,
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis
                )
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    group.events.forEach { event ->
                        TimelineOperationRow(event)
                    }
                }
            }
        }
    }
}

@Composable
private fun TimelineOperationRow(event: TimelineItem) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(SheetBlack, RoundedCornerShape(10.dp))
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp)
    ) {
        Text(compactOperationTitle(event), color = PrimaryText, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium)
        if (event.summary.isNotBlank()) {
            Text(event.summary, color = SecondaryText, style = MaterialTheme.typography.bodySmall, maxLines = 4, overflow = TextOverflow.Ellipsis)
        }
        Text("${event.type} · ${formatMetaTime(event.createdAt)}", color = TertiaryText, style = MaterialTheme.typography.labelSmall)
    }
}

@Composable
private fun ChatComposer(selectedSession: CodexSession?, online: Boolean, onPromptSend: (String) -> Unit) {
    var prompt by remember(selectedSession?.sessionId) { mutableStateOf("") }
    val enabled = selectedSession != null && online

    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(99.dp),
        color = ComposerBlack,
        border = BorderStroke(1.dp, StrokeDark)
    ) {
        Row(
            modifier = Modifier.padding(start = 8.dp, end = 8.dp, top = 7.dp, bottom = 7.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text("+", color = PrimaryText, style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(horizontal = 10.dp))
            TextField(
                modifier = Modifier.weight(1f),
                value = prompt,
                onValueChange = { prompt = it },
                enabled = enabled,
                singleLine = true,
                placeholder = { Text(if (selectedSession == null) "Select a session" else "Message Codex", color = TertiaryText) },
                colors = TextFieldDefaults.colors(
                    focusedContainerColor = Color.Transparent,
                    unfocusedContainerColor = Color.Transparent,
                    disabledContainerColor = Color.Transparent,
                    focusedIndicatorColor = Color.Transparent,
                    unfocusedIndicatorColor = Color.Transparent,
                    disabledIndicatorColor = Color.Transparent,
                    focusedTextColor = PrimaryText,
                    unfocusedTextColor = PrimaryText,
                    disabledTextColor = TertiaryText
                )
            )
            Button(
                enabled = enabled && prompt.isNotBlank(),
                shape = RoundedCornerShape(99.dp),
                colors = ButtonDefaults.buttonColors(containerColor = AccentBlue, disabledContainerColor = StrokeDark),
                onClick = {
                    onPromptSend(prompt)
                    prompt = ""
                }
            ) {
                Text("Send")
            }
        }
    }
}

@Composable
private fun ConnectionToolCard(uiState: RelayUiState, onReconnect: () -> Unit, onHealthCheck: () -> Unit) {
    Panel {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            SectionTitle("Relay")
            Text(diagnosticsSummary(uiState), color = MutedText, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                CompactActionButton(modifier = Modifier.weight(1f), text = "Reconnect", onClick = onReconnect)
                CompactActionButton(modifier = Modifier.weight(1f), text = "Test", onClick = onHealthCheck)
            }
        }
    }
}

@Composable
private fun CircleTextButton(text: String, onClick: () -> Unit, wide: Boolean = false) {
    Surface(
        modifier = Modifier
            .height(54.dp)
            .width(if (wide) 82.dp else 54.dp)
            .clip(RoundedCornerShape(99.dp))
            .clickable(onClick = onClick),
        shape = RoundedCornerShape(99.dp),
        color = CardBlack,
        border = BorderStroke(1.dp, StrokeDark)
    ) {
        Box(contentAlignment = Alignment.Center) {
            Text(text, color = PrimaryText, fontWeight = FontWeight.SemiBold, maxLines = 1)
        }
    }
}

@Composable
private fun StatusOrb(status: String, onClick: () -> Unit) {
    val tone = statusTone(status)
    Surface(
        modifier = Modifier.size(44.dp).clip(RoundedCornerShape(99.dp)).clickable(onClick = onClick),
        shape = RoundedCornerShape(99.dp),
        color = tone.background,
        border = BorderStroke(1.dp, StrokeDark)
    ) {
        Box(contentAlignment = Alignment.Center) {
            Box(modifier = Modifier.size(10.dp).clip(RoundedCornerShape(10.dp)).background(tone.foreground))
        }
    }
}

@Composable
private fun DarkToggleChip(text: String, selected: Boolean, onClick: () -> Unit) {
    Surface(
        modifier = Modifier.clip(RoundedCornerShape(99.dp)).clickable(onClick = onClick),
        shape = RoundedCornerShape(99.dp),
        color = if (selected) PrimaryText else CardBlack,
        border = BorderStroke(1.dp, if (selected) PrimaryText else StrokeDark)
    ) {
        Text(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 9.dp),
            text = text,
            color = if (selected) AppBlack else PrimaryText,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal
        )
    }
}

@Composable
private fun DarkTextField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    singleLine: Boolean = true,
    password: Boolean = false,
    minHeight: androidx.compose.ui.unit.Dp = 56.dp
) {
    TextField(
        modifier = Modifier.fillMaxWidth().heightIn(min = minHeight),
        value = value,
        onValueChange = onValueChange,
        singleLine = singleLine,
        label = { Text(label) },
        visualTransformation = if (password) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
        colors = TextFieldDefaults.colors(
            focusedContainerColor = ComposerBlack,
            unfocusedContainerColor = ComposerBlack,
            disabledContainerColor = ComposerBlack,
            focusedIndicatorColor = AccentBlue,
            unfocusedIndicatorColor = StrokeDark,
            focusedLabelColor = SecondaryText,
            unfocusedLabelColor = SecondaryText,
            focusedTextColor = PrimaryText,
            unfocusedTextColor = PrimaryText,
            cursorColor = AccentBlue
        ),
        shape = RoundedCornerShape(18.dp)
    )
}

private enum class PairingMode { Code, Manual }

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

private sealed class TimelineDisplayItem {
    abstract val stableKey: String

    data class Event(val event: TimelineItem) : TimelineDisplayItem() {
        override val stableKey: String = event.eventId
    }

    data class TurnGroup(
        val groupId: String,
        val events: List<TimelineItem>
    ) : TimelineDisplayItem() {
        override val stableKey: String = "turn:$groupId"
        val latestCreatedAt: String = events.firstOrNull()?.createdAt.orEmpty()
    }
}

private fun buildTimelineDisplayItems(events: List<TimelineItem>): List<TimelineDisplayItem> {
    val completedTurnKeys = events
        .filter { it.type == "turn_completed" }
        .map { timelineWorkKey(it) }
        .toSet()
    val turnKeysClosedByNewerPrompt = events
        .filter { isUserPrompt(it) }
        .map { timelineWorkKey(it) }
        .distinct()
        .drop(1)
        .toSet()
    val foldableTurnKeys = completedTurnKeys + turnKeysClosedByNewerPrompt
    val completedTurnGroups = events
        .filter { shouldFoldIntoCompletedTurn(it, foldableTurnKeys) }
        .groupBy { timelineWorkKey(it) }
    val emittedGroups = mutableSetOf<String>()
    val items = mutableListOf<TimelineDisplayItem>()

    for (event in events) {
        val groupId = timelineWorkKey(event)
        if (shouldFoldIntoCompletedTurn(event, foldableTurnKeys)) {
            if (emittedGroups.add(groupId)) {
                items.add(TimelineDisplayItem.TurnGroup(groupId, completedTurnGroups[groupId].orEmpty()))
            }
        } else {
            items.add(TimelineDisplayItem.Event(event))
        }
    }

    return items
}

private fun shouldFoldIntoCompletedTurn(event: TimelineItem, completedTurnKeys: Set<String>): Boolean {
    if (isUserPrompt(event)) {
        return false
    }

    if (isActiveOperation(event)) {
        return false
    }

    return timelineWorkKey(event) in completedTurnKeys
}

private fun isUserPrompt(event: TimelineItem): Boolean {
    return event.type == "user_prompt"
        || event.title.contains("prompt", ignoreCase = true)
        || event.type.contains("user", ignoreCase = true)
}

private fun isCodexOperationDetail(event: TimelineItem): Boolean {
    return event.type in setOf(
        "command_execution",
        "command_output_delta",
        "file_changed",
        "tool_call",
        "diff_update",
        "plan_update",
        "reasoning_summary",
        "request_resolved"
    )
}

private fun isActiveOperation(event: TimelineItem): Boolean {
    val text = "${event.type} ${event.title} ${event.summary}".lowercase()
    return text.contains("running")
        || text.contains("started")
        || text.contains("pending")
        || text.contains("in_progress")
        || text.contains("in-progress")
}

private fun looksCompletedOperation(event: TimelineItem): Boolean {
    val text = "${event.title} ${event.summary}".lowercase()
    return text.contains("completed")
        || text.contains("succeeded")
        || text.contains("success")
        || text.contains("failed")
        || text.contains("exit")
        || text.contains("resolved")
}

private fun timelineWorkKey(event: TimelineItem): String {
    val parts = event.eventId.split(":")
    return if (parts.size >= 4) {
        "${parts[0]}:${parts[1]}"
    } else {
        "${event.sessionId}:${event.createdAt.take(16)}"
    }
}

private fun compactOperationTitle(event: TimelineItem): String {
    return when (event.type) {
        "command_execution" -> "Command"
        "command_output_delta" -> "Command output"
        "file_changed" -> "Files"
        "tool_call" -> event.title.ifBlank { "Tool" }
        "diff_update" -> "Diff"
        "plan_update" -> "Plan"
        "reasoning_summary" -> "Reasoning"
        "request_resolved" -> "Request"
        else -> event.title.ifBlank { event.type }
    }
}

private fun compactTurnSummary(events: List<TimelineItem>): String {
    val assistantMessage = events.firstOrNull { it.type == "assistant_message" && it.summary.isNotBlank() }
    if (assistantMessage != null) {
        return assistantMessage.summary
    }

    val meaningfulEvents = events
        .filterNot { it.type == "turn_started" || it.type == "turn_completed" }
        .take(4)
        .map { compactOperationTitle(it) }
        .distinct()

    return if (meaningfulEvents.isEmpty()) {
        "Completed Codex work. Tap to inspect details."
    } else {
        meaningfulEvents.joinToString(" - ")
    }
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
private val AppBlack = Color(0xFF050505)
private val SheetBlack = Color(0xFF0B0B0C)
private val CardBlack = Color(0xFF1C1C1E)
private val ComposerBlack = Color(0xFF202124)
private val StrokeDark = Color(0xFF343437)
private val PrimaryText = Color(0xFFF5F5F6)
private val SecondaryText = Color(0xFFB8B8BE)
private val TertiaryText = Color(0xFF77777F)
private val AccentBlue = Color(0xFF2F70D0)

private fun diagnosticsSummary(uiState: RelayUiState): String {
    val connectedAt = uiState.lastConnectedAt ?: "never"
    val selected = uiState.selectedSession?.projectName ?: "none"
    return "sessions=${uiState.sessions.size}, approvals=${uiState.pendingApprovals.size}, events=${uiState.timeline.size}, selected=$selected, last connected=$connectedAt"
}

private fun formatMetaTime(raw: String): String {
    if (raw.isBlank()) {
        return "unknown"
    }

    return runCatching {
        val instant = Instant.parse(raw)
        val formatter = DateTimeFormatter.ofPattern("MM-dd HH:mm").withZone(ZoneId.systemDefault())
        formatter.format(instant)
    }.getOrDefault(raw.take(16))
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
