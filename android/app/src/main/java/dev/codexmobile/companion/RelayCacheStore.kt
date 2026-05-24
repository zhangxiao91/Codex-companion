package dev.codexmobile.companion

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import org.json.JSONArray
import org.json.JSONObject

class RelayCacheStore(context: Context) {
    private val database = Room.databaseBuilder(
        context.applicationContext,
        RelayCacheDatabase::class.java,
        "relay_cache.db"
    )
        .fallbackToDestructiveMigration(dropAllTables = true)
        .allowMainThreadQueries()
        .build()
    private val dao = database.dao()

    fun selectedSessionId(): String? = dao.appState(APP_STATE_SELECTED_SESSION)?.value?.takeIf { it.isNotBlank() }

    fun saveSelectedSessionId(sessionId: String?) {
        saveAppState(APP_STATE_SELECTED_SESSION, sessionId.orEmpty())
    }

    fun pinnedSessionIds(): Set<String> {
        val raw = dao.appState(APP_STATE_PINNED_SESSIONS)?.value.orEmpty()
        return runCatching {
            val array = JSONArray(raw)
            buildSet {
                for (index in 0 until array.length()) {
                    val value = array.optString(index, "").trim()
                    if (value.isNotBlank()) {
                        add(value)
                    }
                }
            }
        }.getOrDefault(emptySet())
    }

    fun savePinnedSessionIds(sessionIds: Set<String>) {
        saveAppState(
            APP_STATE_PINNED_SESSIONS,
            JSONArray(sessionIds.sorted()).toString()
        )
    }

    fun sessions(): List<CodexSession> = dao.sessions().mapNotNull { it.toModel() }

    fun saveSessions(sessions: List<CodexSession>) {
        dao.upsertSessions(sessions.map { CachedSession.fromModel(it) })
    }

    fun clearSessions() {
        dao.clearSessions()
    }

    fun timeline(): List<TimelineItem> = dao.timeline(MAX_TIMELINE_ITEMS).mapNotNull { it.toModel() }

    fun saveTimeline(timeline: List<TimelineItem>) {
        dao.upsertTimeline(timeline.map { CachedTimelineItem.fromModel(it) })
        dao.trimTimeline(MAX_TIMELINE_ITEMS)
        updateSyncStateFromTimeline(timeline)
    }

    fun syncState(sessionId: String): CachedSyncState? = dao.syncState(sessionId)

    fun saveSyncState(sessionId: String, latestCursor: String?, earliestCursor: String?) {
        dao.upsertSyncState(
            CachedSyncState(
                sessionId = sessionId,
                latestCursor = latestCursor,
                earliestCursor = earliestCursor,
                lastSyncedAt = java.time.Instant.now().toString()
            )
        )
    }

    fun promptQueues(): Map<String, PromptQueueState> =
        dao.promptQueues().associate { it.sessionId to it.toModel() }

    fun savePromptQueues(queues: Map<String, PromptQueueState>) {
        dao.clearPromptQueues()
        dao.upsertPromptQueues(queues.values.map { CachedPromptQueue.fromModel(it) })
    }

    fun markNotificationSeen(key: String, kind: String): Boolean {
        val existing = dao.notification(key)
        if (existing != null) {
            return false
        }
        dao.insertNotification(
            CachedNotification(
                notificationKey = key,
                kind = kind,
                seenAt = java.time.Instant.now().toString()
            )
        )
        return true
    }

    fun clearSessionCache() {
        dao.clearSessions()
        dao.clearTimeline()
        dao.clearPromptQueues()
        dao.clearSyncStates()
        dao.clearAppState()
        dao.clearNotifications()
    }

    private fun saveAppState(key: String, value: String) {
        dao.upsertAppState(CachedAppState(key = key, value = value))
    }

    private fun updateSyncStateFromTimeline(timeline: List<TimelineItem>) {
        val grouped = timeline.groupBy { it.sessionId }
        for ((sessionId, events) in grouped) {
            val cursors = events.mapNotNull { it.cursor?.toLongOrNull() }
            if (cursors.isEmpty()) {
                continue
            }
            saveSyncState(sessionId, cursors.maxOrNull()?.toString(), cursors.minOrNull()?.toString())
        }
    }

    companion object {
        const val MAX_TIMELINE_ITEMS = 2000
        const val APP_STATE_SELECTED_SESSION = "selected_session_id"
        const val APP_STATE_PINNED_SESSIONS = "pinned_session_ids"
    }
}

@Database(
    entities = [
        CachedAppState::class,
        CachedSession::class,
        CachedTimelineItem::class,
        CachedSyncState::class,
        CachedPromptQueue::class,
        CachedNotification::class
    ],
    version = 1
)
abstract class RelayCacheDatabase : RoomDatabase() {
    abstract fun dao(): RelayCacheDao
}

@Dao
interface RelayCacheDao {
    @Query("SELECT * FROM cached_app_state WHERE key = :key LIMIT 1")
    fun appState(key: String): CachedAppState?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun upsertAppState(state: CachedAppState)

    @Query("DELETE FROM cached_app_state")
    fun clearAppState()

    @Query("SELECT * FROM cached_sessions ORDER BY updatedAt DESC")
    fun sessions(): List<CachedSession>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun upsertSessions(sessions: List<CachedSession>)

    @Query("DELETE FROM cached_sessions")
    fun clearSessions()

    @Query("SELECT * FROM cached_timeline ORDER BY cursorValue DESC, createdAt DESC LIMIT :limit")
    fun timeline(limit: Int): List<CachedTimelineItem>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun upsertTimeline(items: List<CachedTimelineItem>)

    @Query("DELETE FROM cached_timeline WHERE eventId NOT IN (SELECT eventId FROM cached_timeline ORDER BY cursorValue DESC, createdAt DESC LIMIT :limit)")
    fun trimTimeline(limit: Int)

    @Query("DELETE FROM cached_timeline")
    fun clearTimeline()

    @Query("SELECT * FROM cached_sync_state WHERE sessionId = :sessionId LIMIT 1")
    fun syncState(sessionId: String): CachedSyncState?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun upsertSyncState(state: CachedSyncState)

    @Query("DELETE FROM cached_sync_state")
    fun clearSyncStates()

    @Query("SELECT * FROM cached_prompt_queues")
    fun promptQueues(): List<CachedPromptQueue>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun upsertPromptQueues(queues: List<CachedPromptQueue>)

    @Query("DELETE FROM cached_prompt_queues")
    fun clearPromptQueues()

    @Query("SELECT * FROM cached_notifications WHERE notificationKey = :key LIMIT 1")
    fun notification(key: String): CachedNotification?

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    fun insertNotification(notification: CachedNotification)

    @Query("DELETE FROM cached_notifications")
    fun clearNotifications()
}

@Entity(tableName = "cached_app_state")
data class CachedAppState(
    @PrimaryKey val key: String,
    val value: String
)

@Entity(tableName = "cached_sessions")
data class CachedSession(
    @PrimaryKey val sessionId: String,
    val hostId: String,
    val projectName: String,
    val repoPath: String,
    val branch: String,
    val status: String,
    val summary: String,
    val updatedAt: String,
    val stageJson: String
) {
    fun toModel(): CodexSession? = runCatching {
        val stage = JSONObject(stageJson)
        CodexSession(
            sessionId = sessionId,
            hostId = hostId,
            projectName = projectName,
            repoPath = repoPath,
            branch = branch,
            status = status,
            summary = summary,
            updatedAt = updatedAt,
            stage = SessionStage(
                type = stage.optString("type", "idle"),
                label = stage.optString("label", "Idle"),
                summary = stage.optString("summary", summary),
                severity = stage.optString("severity", "neutral"),
                updatedAt = stage.optString("updated_at", updatedAt)
            )
        )
    }.getOrNull()

    companion object {
        fun fromModel(session: CodexSession) = CachedSession(
            sessionId = session.sessionId,
            hostId = session.hostId,
            projectName = session.projectName,
            repoPath = session.repoPath,
            branch = session.branch,
            status = session.status,
            summary = session.summary,
            updatedAt = session.updatedAt,
            stageJson = JSONObject()
                .put("type", session.stage.type)
                .put("label", session.stage.label)
                .put("summary", session.stage.summary)
                .put("severity", session.stage.severity)
                .put("updated_at", session.stage.updatedAt)
                .toString()
        )
    }
}

@Entity(tableName = "cached_timeline")
data class CachedTimelineItem(
    @PrimaryKey val eventId: String,
    val sessionId: String,
    val type: String,
    val title: String,
    val summary: String,
    val createdAt: String,
    val cursor: String?,
    val cursorValue: Long,
    val payloadJson: String
) {
    fun toModel(): TimelineItem = TimelineItem(
        eventId = eventId,
        sessionId = sessionId,
        type = type,
        title = title,
        summary = summary,
        createdAt = createdAt,
        cursor = cursor
    )

    companion object {
        fun fromModel(event: TimelineItem) = CachedTimelineItem(
            eventId = event.eventId,
            sessionId = event.sessionId,
            type = event.type,
            title = event.title,
            summary = event.summary,
            createdAt = event.createdAt,
            cursor = event.cursor,
            cursorValue = event.cursor?.toLongOrNull() ?: 0L,
            payloadJson = JSONObject()
                .put("event_id", event.eventId)
                .put("session_id", event.sessionId)
                .put("type", event.type)
                .put("title", event.title)
                .put("summary", event.summary)
                .put("created_at", event.createdAt)
                .put("cursor", event.cursor ?: "")
                .toString()
        )
    }
}

@Entity(tableName = "cached_sync_state")
data class CachedSyncState(
    @PrimaryKey val sessionId: String,
    val latestCursor: String?,
    val earliestCursor: String?,
    val lastSyncedAt: String
)

@Entity(tableName = "cached_prompt_queues")
data class CachedPromptQueue(
    @PrimaryKey val sessionId: String,
    val depth: Int,
    val maxDepth: Int,
    val updatedAt: String
) {
    fun toModel(): PromptQueueState = PromptQueueState(sessionId, depth, maxDepth)

    companion object {
        fun fromModel(queue: PromptQueueState) = CachedPromptQueue(
            sessionId = queue.sessionId,
            depth = queue.depth,
            maxDepth = queue.maxDepth,
            updatedAt = java.time.Instant.now().toString()
        )
    }
}

@Entity(tableName = "cached_notifications")
data class CachedNotification(
    @PrimaryKey val notificationKey: String,
    val kind: String,
    val seenAt: String
)
