package dev.codexmobile.companion

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
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
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            CompanionApp()
        }
    }
}

@Composable
private fun CompanionApp() {
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
            SessionDashboard()
        }
    }
}

@Composable
private fun SessionDashboard() {
    var prompt by remember { mutableStateOf("总结当前进度") }
    val events = listOf(
        TimelineItem("running", "Prompt sent to Codex", "Started turn on ephemeral session."),
        TimelineItem("live", "Assistant message delta", "OK"),
        TimelineItem("cache", "Cursor recovery ready", "Relay can replay missed timeline events.")
    )

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp, vertical = 18.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        Header()
        HostSummary()
        SessionSummary()
        TimelineList(events = events, modifier = Modifier.weight(1f))
        PromptComposer(
            value = prompt,
            onValueChange = { prompt = it }
        )
    }
}

@Composable
private fun Header() {
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
        StatusPill(text = "Local relay")
    }
}

@Composable
private fun HostSummary() {
    Panel {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text("local-dev-host", fontWeight = FontWeight.SemiBold)
                Text(
                    text = "ws://127.0.0.1:8787",
                    style = MaterialTheme.typography.bodySmall,
                    color = Color(0xFF5E6978),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }
            StatusPill(text = "Online")
        }
    }
}

@Composable
private fun SessionSummary() {
    Panel {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text("Ephemeral prompt verification", fontWeight = FontWeight.SemiBold)
                StatusPill(text = "Running")
            }
            Text(
                text = "Live assistant events and cursor recovery are available for the mobile shell.",
                style = MaterialTheme.typography.bodyMedium,
                color = Color(0xFF344054)
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
            LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                items(events) { item ->
                    TimelineRow(item)
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
            HorizontalDivider(
                modifier = Modifier.padding(top = 10.dp),
                color = DividerDefaults.color.copy(alpha = 0.6f)
            )
        }
    }
}

@Composable
private fun PromptComposer(value: String, onValueChange: (String) -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        TextField(
            modifier = Modifier.weight(1f),
            value = value,
            onValueChange = onValueChange,
            singleLine = true
        )
        Button(
            onClick = {},
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

private data class TimelineItem(
    val type: String,
    val title: String,
    val summary: String
)
