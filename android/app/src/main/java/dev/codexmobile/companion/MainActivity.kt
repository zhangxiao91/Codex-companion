package dev.codexmobile.companion

import android.os.Bundle
import android.Manifest
import android.os.Build
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
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
import androidx.compose.material3.OutlinedTextField
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
import androidx.activity.compose.BackHandler
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
    private val localNotifier by lazy { LocalNotifier(this) }
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
                onPinnedSessionToggle = viewModel::togglePinnedSession,
                onLoadEarlierTimeline = viewModel::loadEarlierTimeline,
                onScanQrCode = ::scanPairingCode,
                onNotificationsEnabled = { localNotifier.notificationsAllowed() },
                onSessionNotify = localNotifier::notifySessionStage,
                onApprovalNotify = localNotifier::notifyApproval,
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
    onPinnedSessionToggle: (String) -> Unit,
    onLoadEarlierTimeline: () -> Unit,
    onScanQrCode: () -> Unit,
    onNotificationsEnabled: () -> Boolean,
    onSessionNotify: (CodexSession) -> Unit,
    onApprovalNotify: (ApprovalItem) -> Unit,
    scanNotice: String?
) {
    var detailOpen by remember { mutableStateOf(false) }

    LaunchedEffect(uiState.deviceToken) {
        if (uiState.deviceToken.isBlank()) {
            detailOpen = false
        }
    }

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
            } else if (detailOpen && uiState.selectedSession != null) {
                BackHandler { detailOpen = false }
                MainSessionScreen(
                    uiState = uiState,
                    onReconnect = onReconnect,
                    onBackToInbox = { detailOpen = false },
                    onSessionSelected = { sessionId ->
                        onSessionSelected(sessionId)
                        detailOpen = true
                    },
                    onGitStatus = onGitStatus,
                    onGitDiff = onGitDiff,
                    onGitFileDiff = onGitFileDiff,
                    onGitCommit = onGitCommit,
                    onGitPush = onGitPush,
                    onGitAuditRefresh = onGitAuditRefresh,
                    onApprovalDecision = onApprovalDecision,
                    onPromptSend = onPromptSend,
                    onNewChat = onNewChat,
                    onPinnedSessionToggle = onPinnedSessionToggle,
                    onLoadEarlierTimeline = onLoadEarlierTimeline,
                    onHealthCheck = onHealthCheck
                )
            } else {
                InboxScreen(
                    uiState = uiState,
                    onReconnect = onReconnect,
                    onSessionSelected = { sessionId ->
                        onSessionSelected(sessionId)
                        detailOpen = true
                    },
                    onNewChat = onNewChat,
                    onPromptSend = onPromptSend,
                    onPinnedSessionToggle = onPinnedSessionToggle,
                    onNotificationsEnabled = onNotificationsEnabled,
                    onSessionNotify = onSessionNotify,
                    onApprovalNotify = onApprovalNotify,
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
private fun InboxScreen(
    uiState: RelayUiState,
    onReconnect: () -> Unit,
    onSessionSelected: (String) -> Unit,
    onNewChat: () -> Unit,
    onPromptSend: (String) -> Unit,
    onPinnedSessionToggle: (String) -> Unit,
    onNotificationsEnabled: () -> Boolean,
    onSessionNotify: (CodexSession) -> Unit,
    onApprovalNotify: (ApprovalItem) -> Unit,
    onHealthCheck: () -> Unit
) {
    var hostsOpen by remember { mutableStateOf(false) }
    var actionsOpen by remember { mutableStateOf(false) }
    var notificationBaselineReady by remember { mutableStateOf(false) }
    val notificationPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { }

    val inboxSessions = remember(uiState.sessions, uiState.pinnedSessionIds) {
        sortInboxSessions(uiState.sessions, uiState.pinnedSessionIds)
    }

    LaunchedEffect(uiState.sessions, uiState.approvals) {
        if (!notificationBaselineReady) {
            notificationBaselineReady = true
            return@LaunchedEffect
        }
        uiState.sessions.forEach(onSessionNotify)
        uiState.pendingApprovals.forEach(onApprovalNotify)
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .navigationBarsPadding()
            .padding(horizontal = 18.dp, vertical = 18.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        InboxTopBar(
            uiState = uiState,
            onNewChat = onNewChat,
            onMore = { actionsOpen = true }
        )
        MainStatusNotice(uiState)
        InboxMetricRow(uiState)
        if (!onNotificationsEnabled() && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            NotificationPermissionStrip {
                notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
        if (uiState.pendingApprovals.isNotEmpty()) {
            InboxAttentionStrip(
                title = "${uiState.pendingApprovals.size} approval${if (uiState.pendingApprovals.size == 1) "" else "s"} waiting",
                body = uiState.pendingApprovals.first().summary.ifBlank { uiState.pendingApprovals.first().title }
            )
        }
        if (inboxSessions.isEmpty()) {
            EmptyMainState(
                title = "Waiting for Codex",
                body = "Sessions from your trusted hosts will land here as a single inbox."
            )
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                items(inboxSessions, key = { it.sessionId }) { session ->
                    InboxSessionCard(
                        session = session,
                        latestEvent = latestTimelineForSession(uiState.timeline, session.sessionId),
                        pinned = session.sessionId in uiState.pinnedSessionIds,
                        onPinToggle = { onPinnedSessionToggle(session.sessionId) },
                        onClick = { onSessionSelected(session.sessionId) }
                    )
                }
            }
        }
    }

    if (hostsOpen) {
        ModalBottomSheet(
            onDismissRequest = { hostsOpen = false },
            containerColor = SheetBlack,
            contentColor = PrimaryText,
            dragHandle = null
        ) {
            HostWorkbenchSheet(uiState = uiState)
        }
    }

    if (actionsOpen) {
        ModalBottomSheet(
            onDismissRequest = { actionsOpen = false },
            containerColor = SheetBlack,
            contentColor = PrimaryText,
            dragHandle = null
        ) {
            InboxActionSheet(
                uiState = uiState,
                onNewChat = {
                    actionsOpen = false
                    onNewChat()
                },
                onHosts = {
                    actionsOpen = false
                    hostsOpen = true
                },
                onReconnect = {
                    actionsOpen = false
                    onReconnect()
                },
                onHealthCheck = {
                    actionsOpen = false
                    onHealthCheck()
                }
            )
        }
    }
}

@Composable
private fun NotificationPermissionStrip(onEnable: () -> Unit) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = CardBlack.copy(alpha = 0.78f),
        shape = RoundedCornerShape(18.dp),
        border = BorderStroke(1.dp, StrokeDark)
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text("Enable notifications", color = PrimaryText, fontWeight = FontWeight.SemiBold)
                Text("Get notified only for completion, failures, approvals, and blockers.", color = SecondaryText, style = MaterialTheme.typography.bodySmall)
            }
            TextButton(onClick = onEnable, colors = ButtonDefaults.textButtonColors(contentColor = PrimaryText)) {
                Text("Enable")
            }
        }
    }
}

@Composable
private fun InboxTopBar(
    uiState: RelayUiState,
    onNewChat: () -> Unit,
    onMore: () -> Unit
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("Command Center", color = PrimaryText, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
            Text(
                text = "${uiState.connectionStatus} / ${uiState.sessions.size} sessions / ${uiState.hosts.count { it.status == "online" }} online hosts",
                color = SecondaryText,
                style = MaterialTheme.typography.bodySmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            PrimaryPillButton(
                text = "New Chat",
                enabled = uiState.connectionStatus == "Online",
                onClick = onNewChat
            )
            CircleTextButton(text = "More", onClick = onMore, wide = true)
        }
    }
}

@Composable
private fun MainStatusNotice(uiState: RelayUiState) {
    val message = uiState.lastError ?: uiState.lastHealthCheck
    if (message.isNullOrBlank()) {
        return
    }
    InlineNotice(
        text = message,
        tone = if (uiState.lastError.isNullOrBlank()) NoticeTone.Neutral else NoticeTone.Critical
    )
}

@Composable
private fun InboxActionSheet(
    uiState: RelayUiState,
    onNewChat: () -> Unit,
    onHosts: () -> Unit,
    onReconnect: () -> Unit,
    onHealthCheck: () -> Unit
) {
    Column(
        modifier = Modifier
            .navigationBarsPadding()
            .padding(horizontal = 18.dp, vertical = 22.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        Text("Control", color = PrimaryText, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
        Text("Low-frequency actions stay here so the inbox can stay calm.", color = SecondaryText, style = MaterialTheme.typography.bodySmall)
        ActionSheetButton(
            title = "Start a new chat",
            detail = "Create a fresh Codex session on the active host.",
            enabled = uiState.connectionStatus == "Online",
            onClick = onNewChat
        )
        ActionSheetButton(
            title = "Execution nodes",
            detail = "${uiState.hosts.count { it.status == "online" }} online / ${uiState.hosts.size} total hosts.",
            onClick = onHosts
        )
        ActionSheetButton(
            title = if (uiState.connectionStatus == "Online") "Refresh relay" else "Reconnect relay",
            detail = "Reopen the WebSocket and refresh live session state.",
            onClick = onReconnect
        )
        ActionSheetButton(
            title = "Test connection",
            detail = "Run the Relay health check and show the result here.",
            onClick = onHealthCheck
        )
    }
}

@Composable
private fun ActionSheetButton(
    title: String,
    detail: String,
    enabled: Boolean = true,
    onClick: () -> Unit
) {
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(18.dp))
            .clickable(enabled = enabled, onClick = onClick),
        color = if (enabled) ElevatedBlack else CardBlack.copy(alpha = 0.48f),
        shape = RoundedCornerShape(18.dp),
        border = BorderStroke(1.dp, if (enabled) HairlineDark else StrokeDark.copy(alpha = 0.55f))
    ) {
        Column(modifier = Modifier.padding(horizontal = 15.dp, vertical = 13.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(title, color = if (enabled) PrimaryText else TertiaryText, fontWeight = FontWeight.SemiBold)
            Text(detail, color = TertiaryText, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
private fun PrimaryPillButton(text: String, enabled: Boolean = true, onClick: () -> Unit) {
    Surface(
        modifier = Modifier
            .height(44.dp)
            .widthIn(min = 96.dp)
            .clip(RoundedCornerShape(99.dp))
            .clickable(enabled = enabled, onClick = onClick),
        shape = RoundedCornerShape(99.dp),
        color = if (enabled) PrimaryText else StrokeDark,
        border = BorderStroke(1.dp, if (enabled) PrimaryText else HairlineDark)
    ) {
        Box(contentAlignment = Alignment.Center) {
            Text(
                modifier = Modifier.padding(horizontal = 14.dp),
                text = text,
                color = if (enabled) AppBlack else TertiaryText,
                style = MaterialTheme.typography.labelMedium,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1
            )
        }
    }
}

@Composable
private fun InboxMetricRow(uiState: RelayUiState) {
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        InboxMetric("Attention", uiState.sessions.count { needsAttention(it) }.toString(), Modifier.weight(1f))
        InboxMetric("Active", uiState.sessions.count { it.stage.severity == "active" }.toString(), Modifier.weight(1f))
        InboxMetric("Approvals", uiState.pendingApprovals.size.toString(), Modifier.weight(1f))
    }
}

@Composable
private fun InboxMetric(label: String, value: String, modifier: Modifier = Modifier) {
    Surface(
        modifier = modifier.height(72.dp),
        color = ElevatedBlack,
        shape = RoundedCornerShape(16.dp),
        border = BorderStroke(1.dp, HairlineDark)
    ) {
        Column(modifier = Modifier.padding(horizontal = 13.dp, vertical = 11.dp), verticalArrangement = Arrangement.SpaceBetween) {
            Text(value, color = PrimaryText, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
            Text(label.uppercase(), color = TertiaryText, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
private fun InboxAttentionStrip(title: String, body: String) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = AmberPanel,
        shape = RoundedCornerShape(18.dp),
        border = BorderStroke(1.dp, AmberStroke)
    ) {
        Column(modifier = Modifier.padding(horizontal = 15.dp, vertical = 13.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(title, color = PrimaryText, fontWeight = FontWeight.SemiBold)
            Text(body, color = SecondaryText, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
private fun InboxSessionCard(
    session: CodexSession,
    latestEvent: TimelineItem?,
    pinned: Boolean,
    onPinToggle: () -> Unit,
    onClick: () -> Unit
) {
    val tone = stageTone(session.stage)
    val accent = stageAccent(session.stage)

    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(18.dp))
            .clickable(onClick = onClick),
        color = if (needsAttention(session)) ElevatedBlack else CardBlack.copy(alpha = 0.88f),
        shape = RoundedCornerShape(18.dp),
        border = BorderStroke(1.dp, if (needsAttention(session)) accent.copy(alpha = 0.68f) else HairlineDark)
    ) {
        Row {
            Box(
                modifier = Modifier
                    .width(3.dp)
                    .fillMaxHeight()
                    .background(accent)
            )
            Column(modifier = Modifier.padding(horizontal = 15.dp, vertical = 14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.Top) {
                    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(session.projectName, color = PrimaryText, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text("${session.hostId} / ${session.branch}", color = TertiaryText, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    TextButton(
                        modifier = Modifier.height(32.dp),
                        onClick = onPinToggle,
                        colors = ButtonDefaults.textButtonColors(contentColor = if (pinned) PrimaryText else TertiaryText)
                    ) {
                        Text(if (pinned) "Pinned" else "Pin", style = MaterialTheme.typography.labelSmall)
                    }
                }
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    StatusPill(session.stage.label, tone)
                    Text("Updated ${formatMetaTime(session.updatedAt)}", color = TertiaryText, style = MaterialTheme.typography.labelSmall)
                }
                Text(
                    text = session.stage.summary.ifBlank { session.summary.ifBlank { "No current summary." } },
                    color = SecondaryText,
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis
                )
                if (latestEvent != null) {
                    Text(
                        text = "Latest: ${latestEvent.title} / ${cleanTimelineText(latestEvent.summary)}",
                        color = TertiaryText,
                        style = MaterialTheme.typography.labelMedium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                }
                InboxSessionCta(session)
            }
        }
    }
}

@Composable
private fun InboxSessionCta(session: CodexSession) {
    val text = when (session.stage.type) {
        "waiting_approval" -> "Open approval in session tools"
        "tests_failed" -> "Retry with a focused prompt or review Git"
        "needs_user" -> "Send a short instruction to unblock Codex"
        else -> ""
    }
    if (text.isNotBlank()) {
        Text(text, color = TertiaryText, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun QuickActionBar(enabled: Boolean, onQuickPrompt: (String) -> Unit) {
    val actions = quickActionPrompts()
    LazyRow(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        items(actions) { (label, prompt) ->
            QuickActionChip(label = label, enabled = enabled) {
                onQuickPrompt(prompt)
            }
        }
    }
}

@Composable
private fun QuickActionChip(label: String, enabled: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Surface(
        modifier = modifier
            .height(40.dp)
            .widthIn(min = 86.dp)
            .clip(RoundedCornerShape(99.dp))
            .clickable(enabled = enabled, onClick = onClick),
        color = if (enabled) ControlBlack else CardBlack.copy(alpha = 0.5f),
        shape = RoundedCornerShape(99.dp),
        border = BorderStroke(1.dp, if (enabled) HairlineDark else StrokeDark.copy(alpha = 0.55f))
    ) {
        Box(contentAlignment = Alignment.Center) {
            Text(
                modifier = Modifier.padding(horizontal = 13.dp),
                text = label,
                color = if (enabled) PrimaryText else TertiaryText,
                style = MaterialTheme.typography.labelMedium,
                fontWeight = FontWeight.Medium,
                maxLines = 1
            )
        }
    }
}

private fun quickActionPrompts(): List<Pair<String, String>> = listOf(
    "\u7ee7\u7eed" to "\u7ee7\u7eed",
    "\u6362\u4e2a\u65b9\u6848" to "\u6362\u4e2a\u65b9\u6848\uff0c\u5148\u7b80\u8981\u8bf4\u660e\u65b0\u65b9\u6848\u518d\u6267\u884c\u3002",
    "\u53ea\u4fee\u6d4b\u8bd5" to "\u53ea\u4fee\u590d\u5f53\u524d\u5931\u8d25\u7684\u6d4b\u8bd5\uff0c\u4e0d\u505a\u65e0\u5173\u6539\u52a8\u3002",
    "\u603b\u7ed3\u4e00\u4e0b" to "\u603b\u7ed3\u4e00\u4e0b\u5f53\u524d\u8fdb\u5ea6\u3001\u963b\u585e\u70b9\u548c\u4e0b\u4e00\u6b65\u3002"
)

@Composable
private fun HostWorkbenchSheet(uiState: RelayUiState) {
    Column(
        modifier = Modifier
            .navigationBarsPadding()
            .padding(horizontal = 18.dp, vertical = 22.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        Text("Execution Nodes", color = PrimaryText, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
        Text("Read-only host health and capacity for this Relay.", color = SecondaryText, style = MaterialTheme.typography.bodySmall)
        if (uiState.hosts.isEmpty()) {
            Text("No host snapshots yet. Keep Host Bridge online, then reconnect.", color = SecondaryText)
        } else {
            uiState.hosts.forEach { host ->
                HostNodeRow(host)
            }
        }
    }
}

@Composable
private fun HostNodeRow(host: HostNode) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = ElevatedBlack,
        shape = RoundedCornerShape(18.dp),
        border = BorderStroke(1.dp, HairlineDark)
    ) {
        Column(modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(host.displayName, color = PrimaryText, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(host.hostId, color = TertiaryText, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                StatusPill(host.status, statusTone(host.status))
            }
            Text("${host.sessionCount} session${if (host.sessionCount == 1) "" else "s"} - last seen ${formatMetaTime(host.lastSeenAt)}", color = SecondaryText, style = MaterialTheme.typography.bodySmall)
            val capabilities = host.capabilities.take(4).joinToString(" - ").ifBlank { "No capabilities reported" }
            Text(capabilities, color = TertiaryText, style = MaterialTheme.typography.labelMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (host.bridgeVersion.isNotBlank() || host.kind.isNotBlank()) {
                Text(listOf(host.kind, host.bridgeVersion).filter { it.isNotBlank() }.joinToString(" - "), color = TertiaryText, style = MaterialTheme.typography.labelSmall)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MainSessionScreen(
    uiState: RelayUiState,
    onReconnect: () -> Unit,
    onBackToInbox: () -> Unit,
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
    onPinnedSessionToggle: (String) -> Unit,
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
                onPinnedSessionToggle = onPinnedSessionToggle,
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
                onMenu = onBackToInbox,
                onTools = { toolsOpen = true }
            )
            MainStatusNotice(uiState)
            TimelineStream(uiState = uiState, modifier = Modifier.weight(1f), onLoadEarlier = onLoadEarlierTimeline)
            QuickActionBar(
                enabled = uiState.selectedSession != null && uiState.connectionStatus == "Online",
                onQuickPrompt = onPromptSend
            )
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
private fun MainTopBar(uiState: RelayUiState, onMenu: () -> Unit, onTools: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Row(modifier = Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            CircleTextButton(text = "Back", onClick = onMenu, wide = true)
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
                    text = uiState.selectedSession?.let { "${it.branch} - ${it.stage.label}" } ?: "${uiState.sessions.size} live sessions",
                    color = SecondaryText,
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            CircleTextButton(text = "Tools", onClick = onTools, wide = true)
        }
    }
}

@Composable
private fun SessionDrawer(
    uiState: RelayUiState,
    onSessionSelected: (String) -> Unit,
    onNewChat: () -> Unit,
    onPinnedSessionToggle: (String) -> Unit,
    onReconnect: () -> Unit
) {
    var query by remember { mutableStateOf("") }
    var grouping by remember { mutableStateOf(SessionGrouping.Project) }
    val filteredSessions = remember(uiState.sessions, uiState.pinnedSessionIds, query) {
        filterAndSortDrawerSessions(uiState.sessions, uiState.pinnedSessionIds, query)
    }
    val pinnedSessions = filteredSessions.filter { it.sessionId in uiState.pinnedSessionIds }
    val regularSessions = filteredSessions.filterNot { it.sessionId in uiState.pinnedSessionIds }
    val groupedSessions = remember(regularSessions, grouping) { groupDrawerSessions(regularSessions, grouping) }

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
            DrawerSearchField(query = query, onQueryChange = { query = it })
            DrawerGroupingToggle(grouping = grouping, onGroupingChange = { grouping = it })
            Button(
                modifier = Modifier.fillMaxWidth().height(48.dp),
                enabled = uiState.connectionStatus == "Online" && uiState.sessions.isNotEmpty(),
                shape = RoundedCornerShape(99.dp),
                colors = ButtonDefaults.buttonColors(containerColor = PrimaryText, contentColor = AppBlack),
                onClick = onNewChat
            ) {
                Text("New Chat", fontWeight = FontWeight.SemiBold)
            }
            Text("Sessions", color = PrimaryText, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.titleMedium)
            if (uiState.sessions.isEmpty()) {
                Text("No live sessions. Keep Host Bridge online, then refresh.", color = SecondaryText)
                OutlinedButton(onClick = onReconnect, border = BorderStroke(1.dp, StrokeDark)) {
                    Text("Reconnect", color = PrimaryText)
                }
            } else if (filteredSessions.isEmpty()) {
                Text("No sessions match this search.", color = SecondaryText)
            } else {
                LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (pinnedSessions.isNotEmpty()) {
                        item(key = "pinned-header") {
                            DrawerSectionHeader("Pinned")
                        }
                        items(pinnedSessions, key = { "pinned:${it.sessionId}" }) { session ->
                            DrawerSessionRow(
                                session = session,
                                selected = session.sessionId == uiState.selectedSessionId,
                                pinned = true,
                                onPinToggle = { onPinnedSessionToggle(session.sessionId) },
                                onClick = { onSessionSelected(session.sessionId) }
                            )
                        }
                    }
                    groupedSessions.forEach { group ->
                        item(key = "group:${group.title}") {
                            DrawerSectionHeader(group.title, group.detail)
                        }
                        items(group.sessions, key = { it.sessionId }) { session ->
                            DrawerSessionRow(
                                session = session,
                                selected = session.sessionId == uiState.selectedSessionId,
                                pinned = false,
                                onPinToggle = { onPinnedSessionToggle(session.sessionId) },
                                onClick = { onSessionSelected(session.sessionId) }
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun DrawerSearchField(query: String, onQueryChange: (String) -> Unit) {
    OutlinedTextField(
        modifier = Modifier.fillMaxWidth(),
        value = query,
        onValueChange = onQueryChange,
        singleLine = true,
        placeholder = { Text("Search sessions", color = TertiaryText) },
        shape = RoundedCornerShape(16.dp),
        colors = TextFieldDefaults.colors(
            focusedContainerColor = CardBlack,
            unfocusedContainerColor = CardBlack.copy(alpha = 0.74f),
            disabledContainerColor = CardBlack,
            focusedTextColor = PrimaryText,
            unfocusedTextColor = PrimaryText,
            focusedIndicatorColor = StrokeDark,
            unfocusedIndicatorColor = StrokeDark,
            cursorColor = PrimaryText
        )
    )
}

@Composable
private fun DrawerGroupingToggle(grouping: SessionGrouping, onGroupingChange: (SessionGrouping) -> Unit) {
    Row(modifier = Modifier.fillMaxWidth().background(CardBlack.copy(alpha = 0.62f), RoundedCornerShape(99.dp)).padding(4.dp)) {
        SessionGrouping.values().forEach { option ->
            val selected = grouping == option
            Surface(
                modifier = Modifier.weight(1f).clip(RoundedCornerShape(99.dp)).clickable { onGroupingChange(option) },
                color = if (selected) PrimaryText else Color.Transparent,
                shape = RoundedCornerShape(99.dp)
            ) {
                Text(
                    modifier = Modifier.padding(vertical = 8.dp),
                    text = option.label,
                    color = if (selected) AppBlack else SecondaryText,
                    style = MaterialTheme.typography.labelMedium,
                    fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal
                )
            }
        }
    }
}

@Composable
private fun DrawerSectionHeader(title: String, detail: String = "") {
    Row(modifier = Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 2.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
        Text(title, color = TertiaryText, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (detail.isNotBlank()) {
            Text(detail, color = TertiaryText, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
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
private fun DrawerSessionRow(
    session: CodexSession,
    selected: Boolean,
    pinned: Boolean,
    onPinToggle: () -> Unit,
    onClick: () -> Unit
) {
    Surface(
        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).clickable(onClick = onClick),
        color = if (selected) CardBlack else Color.Transparent,
        shape = RoundedCornerShape(14.dp),
        border = if (selected) BorderStroke(1.dp, StrokeDark) else null
    ) {
        Row(
            modifier = Modifier.padding(start = 12.dp, end = 8.dp, top = 10.dp, bottom = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.Top
        ) {
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(session.projectName, color = PrimaryText, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text("${session.branch} · ${session.status}", color = SecondaryText, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text("Updated ${formatMetaTime(session.updatedAt)}", color = TertiaryText, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(session.hostId, color = TertiaryText, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            TextButton(
                modifier = Modifier.height(34.dp),
                onClick = onPinToggle,
                colors = ButtonDefaults.textButtonColors(contentColor = if (pinned) PrimaryText else TertiaryText)
            ) {
                Text(if (pinned) "Pinned" else "Pin", style = MaterialTheme.typography.labelSmall)
            }
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
            shape = RoundedCornerShape(18.dp),
            color = if (isUser) AccentBlue else ElevatedBlack,
            border = if (isUser) null else BorderStroke(1.dp, HairlineDark)
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
        color = ElevatedBlack,
        border = BorderStroke(1.dp, HairlineDark)
    ) {
        Column(modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Column(modifier = Modifier.weight(1f)) {
                    Text("Codex response", color = PrimaryText, fontWeight = FontWeight.SemiBold)
                    Text(
                        text = "${compactTurnMeta(group.events)} - ${formatMetaTime(group.latestCreatedAt)}",
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
            .background(AppBlack.copy(alpha = 0.72f), RoundedCornerShape(12.dp))
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
        color = ControlBlack,
        border = BorderStroke(1.dp, HairlineDark)
    ) {
        Row(
            modifier = Modifier.padding(start = 8.dp, end = 8.dp, top = 7.dp, bottom = 7.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
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
            .height(44.dp)
            .width(if (wide) 88.dp else 44.dp)
            .clip(RoundedCornerShape(99.dp))
            .clickable(onClick = onClick),
        shape = RoundedCornerShape(99.dp),
        color = ControlBlack,
        border = BorderStroke(1.dp, HairlineDark)
    ) {
        Box(contentAlignment = Alignment.Center) {
            Text(text, color = PrimaryText, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, maxLines = 1)
        }
    }
}

@Composable
private fun StatusOrb(status: String, onClick: () -> Unit) {
    val tone = statusTone(status)
    Surface(
        modifier = Modifier.size(44.dp).clip(RoundedCornerShape(99.dp)).clickable(onClick = onClick),
        shape = RoundedCornerShape(99.dp),
        color = ControlBlack,
        border = BorderStroke(1.dp, tone.foreground.copy(alpha = 0.55f))
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
        color = tone.background,
        border = BorderStroke(1.dp, tone.foreground.copy(alpha = 0.24f))
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
    Positive(Color(0xFF0E2A22), Color(0xFF6EE7B7)),
    Warning(Color(0xFF302511), Color(0xFFF2C166)),
    Critical(Color(0xFF351718), Color(0xFFFF8B82)),
    Neutral(Color(0xFF1B222B), Color(0xFF9AA7B7))
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

private enum class SessionGrouping(val label: String) {
    Project("Project"),
    Host("Host")
}

private data class DrawerSessionGroup(
    val title: String,
    val detail: String,
    val sessions: List<CodexSession>
)

private fun filterAndSortDrawerSessions(
    sessions: List<CodexSession>,
    pinnedSessionIds: Set<String>,
    query: String
): List<CodexSession> {
    val normalizedQuery = query.trim().lowercase()
    return sessions
        .filter { session ->
            normalizedQuery.isBlank() || listOf(
                session.projectName,
                session.hostId,
                session.branch,
                session.repoPath,
                session.status,
                session.stage.label,
                session.stage.summary,
                session.summary
            ).any { it.lowercase().contains(normalizedQuery) }
        }
        .sortedWith(
            compareByDescending<CodexSession> { it.sessionId in pinnedSessionIds }
                .thenByDescending { parseIsoMillis(it.updatedAt) }
                .thenBy { it.projectName.lowercase() }
        )
}

private fun sortInboxSessions(sessions: List<CodexSession>, pinnedSessionIds: Set<String>): List<CodexSession> {
    return sessions.sortedWith(
        compareByDescending<CodexSession> { it.sessionId in pinnedSessionIds }
            .thenByDescending { needsAttention(it) }
            .thenByDescending { it.stage.severity == "active" }
            .thenByDescending { parseIsoMillis(it.updatedAt) }
            .thenBy { it.projectName.lowercase() }
    )
}

private fun needsAttention(session: CodexSession): Boolean {
    return session.stage.type in setOf("waiting_approval", "tests_failed", "needs_user")
        || session.stage.severity in setOf("warning", "danger")
}

private fun latestTimelineForSession(timeline: List<TimelineItem>, sessionId: String): TimelineItem? {
    return timeline
        .filter { it.sessionId == sessionId }
        .maxByOrNull { it.cursor?.toLongOrNull() ?: parseIsoMillis(it.createdAt) }
}

private fun groupDrawerSessions(sessions: List<CodexSession>, grouping: SessionGrouping): List<DrawerSessionGroup> {
    return sessions
        .groupBy { session ->
            when (grouping) {
                SessionGrouping.Project -> session.projectName.ifBlank { "Untitled project" }
                SessionGrouping.Host -> session.hostId.ifBlank { "Unknown host" }
            }
        }
        .map { (title, groupSessions) ->
            val sorted = groupSessions.sortedWith(compareByDescending<CodexSession> { parseIsoMillis(it.updatedAt) }
                .thenBy { it.projectName.lowercase() })
            DrawerSessionGroup(
                title = title,
                detail = "${sorted.size} session${if (sorted.size == 1) "" else "s"}",
                sessions = sorted
            )
        }
        .sortedWith(compareByDescending<DrawerSessionGroup> { group ->
            group.sessions.maxOfOrNull { parseIsoMillis(it.updatedAt) } ?: 0L
        }.thenBy { it.title.lowercase() })
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
    val error = events.firstOrNull { it.type == "error" || it.type == "codex_retrying" }
    if (error != null && error.summary.isNotBlank()) {
        return "Needs attention: ${cleanTimelineText(error.summary)}"
    }

    val assistantMessage = events.firstOrNull { it.type == "assistant_message" && it.summary.isNotBlank() }
    val assistantText = assistantMessage?.summary?.let { cleanTimelineText(it) }.orEmpty()
    val details = compactTurnDetailParts(events)

    if (assistantText.isNotBlank() && details.isNotEmpty()) {
        return "${assistantText.trimEnd('.', '。')} - ${details.joinToString(" - ")}"
    }

    if (assistantText.isNotBlank()) {
        return assistantText
    }

    if (details.isNotEmpty()) {
        return details.joinToString(" - ")
    }

    val fallbackEvents = events
        .filterNot { it.type == "turn_started" || it.type == "turn_completed" || it.type == "reasoning_summary" }
        .map { event ->
            val summary = cleanTimelineText(event.summary)
            if (summary.isNotBlank() && summary != event.title) summary else compactOperationTitle(event)
        }
        .distinct()
        .take(3)

    return if (fallbackEvents.isEmpty()) {
        "Completed Codex work. Tap to inspect details."
    } else {
        fallbackEvents.joinToString(" - ")
    }
}

private fun compactTurnMeta(events: List<TimelineItem>): String {
    if (events.any { it.type == "error" || it.type == "codex_retrying" }) {
        return "Needs attention"
    }

    val commandCount = events.count { it.type == "command_execution" }
    val changedFiles = changedFileCount(events)
    val toolCount = events.count { it.type == "tool_call" }
    val meta = mutableListOf<String>()

    if (changedFiles > 0) {
        meta.add("$changedFiles file${if (changedFiles == 1) "" else "s"}")
    }
    if (commandCount > 0) {
        meta.add("$commandCount command${if (commandCount == 1) "" else "s"}")
    }
    if (toolCount > 0) {
        meta.add("$toolCount tool${if (toolCount == 1) "" else "s"}")
    }
    if (events.any { it.type == "assistant_message" }) {
        meta.add("answered")
    }

    return if (meta.isEmpty()) {
        "${events.size} event${if (events.size == 1) "" else "s"}"
    } else {
        meta.take(3).joinToString(" - ")
    }
}

private fun compactTurnDetailParts(events: List<TimelineItem>): List<String> {
    val details = mutableListOf<String>()
    val changedFiles = changedFileCount(events)
    val commandCount = events.count { it.type == "command_execution" }
    val failedCommandCount = events.count {
        it.type == "command_execution" && "${it.title} ${it.summary}".contains("failed", ignoreCase = true)
    }
    val toolCount = events.count { it.type == "tool_call" }

    if (changedFiles > 0) {
        details.add("changed $changedFiles file${if (changedFiles == 1) "" else "s"}")
    }
    if (commandCount > 0) {
        details.add(
            if (failedCommandCount > 0) {
                "ran $commandCount command${if (commandCount == 1) "" else "s"}, $failedCommandCount failed"
            } else {
                "ran $commandCount command${if (commandCount == 1) "" else "s"}"
            }
        )
    }
    if (toolCount > 0) {
        details.add("used $toolCount tool${if (toolCount == 1) "" else "s"}")
    }
    if (events.any { it.type == "diff_update" }) {
        details.add("diff updated")
    }
    if (events.any { it.type == "plan_update" }) {
        details.add("plan updated")
    }

    return details.take(4)
}

private fun changedFileCount(events: List<TimelineItem>): Int {
    val explicitCounts = events
        .filter { it.type == "file_changed" }
        .mapNotNull { fileChangeCountFromSummary(it.summary) }

    if (explicitCounts.isNotEmpty()) {
        return explicitCounts.sum()
    }

    return events.count { it.type == "file_changed" }
}

private fun fileChangeCountFromSummary(summary: String): Int? {
    return Regex("""(\d+)\s+file change""", RegexOption.IGNORE_CASE)
        .find(summary)
        ?.groupValues
        ?.getOrNull(1)
        ?.toIntOrNull()
}

private fun cleanTimelineText(text: String): String {
    return text
        .replace(Regex("""\s+"""), " ")
        .trim()
        .let { if (it.length > 180) "${it.take(177).trimEnd()}..." else it }
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

private fun stageTone(stage: SessionStage): NoticeTone {
    return when (stage.severity.lowercase()) {
        "success" -> NoticeTone.Positive
        "warning" -> NoticeTone.Warning
        "danger" -> NoticeTone.Critical
        "active" -> NoticeTone.Positive
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
private val AppBlack = Color(0xFF070809)
private val SheetBlack = Color(0xFF0D0F12)
private val CardBlack = Color(0xFF15181D)
private val ElevatedBlack = Color(0xFF1A1E24)
private val ControlBlack = Color(0xFF101318)
private val ComposerBlack = Color(0xFF171A20)
private val StrokeDark = Color(0xFF2B313A)
private val HairlineDark = Color(0xFF343B46)
private val PrimaryText = Color(0xFFF4F7FA)
private val SecondaryText = Color(0xFFB3BDC9)
private val TertiaryText = Color(0xFF7D8897)
private val AccentBlue = Color(0xFF4D8DFF)
private val AmberPanel = Color(0xFF261D0D)
private val AmberStroke = Color(0xFF5E4316)

private fun stageAccent(stage: SessionStage): Color {
    return when (stage.severity.lowercase()) {
        "danger" -> Color(0xFFFF7368)
        "warning" -> Color(0xFFF2C166)
        "active" -> AccentBlue
        "success" -> Color(0xFF6EE7B7)
        else -> Color(0xFF596575)
    }
}

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

private fun parseIsoMillis(raw: String): Long {
    if (raw.isBlank()) {
        return 0L
    }

    return runCatching { Instant.parse(raw).toEpochMilli() }.getOrDefault(0L)
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
