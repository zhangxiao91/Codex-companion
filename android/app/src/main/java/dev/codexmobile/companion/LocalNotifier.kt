package dev.codexmobile.companion

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import kotlin.math.absoluteValue

class LocalNotifier(private val context: Context) {
    private val cacheStore = RelayCacheStore(context.applicationContext)

    init {
        ensureChannel()
    }

    fun notifySessionStage(session: CodexSession) {
        if (!notificationsAllowed()) {
            return
        }

        val stageType = session.stage.type
        if (stageType !in NOTIFIABLE_STAGES) {
            return
        }

        val key = "${session.sessionId}:$stageType"
        if (!cacheStore.markNotificationSeen(key, "session_stage")) {
            return
        }

        val title = when (stageType) {
            "waiting_approval" -> "Codex needs approval"
            "tests_failed" -> "Codex needs attention"
            "needs_user" -> "Codex needs input"
            "completed" -> "Codex task completed"
            else -> session.stage.label
        }
        show(
            notificationId = key.hashCode().absoluteValue,
            title = title,
            body = "${session.projectName}: ${session.stage.summary.ifBlank { session.summary }}"
        )
    }

    fun notifyApproval(approval: ApprovalItem) {
        if (!notificationsAllowed() || approval.status != "pending") {
            return
        }
        if (!cacheStore.markNotificationSeen(approval.approvalId, "approval")) {
            return
        }
        show(
            notificationId = approval.approvalId.hashCode().absoluteValue,
            title = "Approval requested",
            body = approval.summary.ifBlank { approval.title }
        )
    }

    fun notifyRelayEvent(notification: NotificationEvent) {
        if (!notificationsAllowed()) {
            return
        }
        if (notification.kind !in NOTIFIABLE_RELAY_KINDS) {
            return
        }
        if (!cacheStore.markNotificationSeen(notification.notificationId, notification.kind)) {
            return
        }
        show(
            notificationId = notification.notificationId.hashCode().absoluteValue,
            title = when (notification.kind) {
                "approval_pending" -> "Approval requested"
                "session_completed" -> "Codex task completed"
                "needs_input" -> "Codex needs input"
                "host_offline" -> "Host offline"
                else -> notification.title
            },
            body = notification.summary.ifBlank { notification.title }
        )
    }

    fun notificationsAllowed(): Boolean {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    }

    private fun show(notificationId: Int, title: String, body: String) {
        val intent = Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val pendingIntent = PendingIntent.getActivity(
            context,
            notificationId,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_more)
            .setContentTitle(title)
            .setContentText(body.take(160))
            .setStyle(NotificationCompat.BigTextStyle().bigText(body.take(400)))
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build()

        NotificationManagerCompat.from(context).notify(notificationId, notification)
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return
        }
        val manager = context.getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Codex updates",
            NotificationManager.IMPORTANCE_DEFAULT
        ).apply {
            description = "Important Codex task updates and approval requests"
        }
        manager.createNotificationChannel(channel)
    }

    private companion object {
        const val CHANNEL_ID = "codex_updates"
        val NOTIFIABLE_STAGES = setOf("waiting_approval", "tests_failed", "needs_user", "completed")
        val NOTIFIABLE_RELAY_KINDS = setOf("approval_pending", "session_completed", "needs_input", "host_offline")
    }
}
