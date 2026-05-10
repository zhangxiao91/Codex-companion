package dev.codexmobile.companion

import android.content.Context

class RelaySettings(context: Context) {
    private val preferences = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    fun relayUrl(): String = preferences.getString(KEY_RELAY_URL, RelayClient.DEFAULT_RELAY_URL)
        ?: RelayClient.DEFAULT_RELAY_URL

    fun saveRelayUrl(url: String) {
        preferences.edit().putString(KEY_RELAY_URL, url).apply()
    }

    private companion object {
        const val PREFERENCES_NAME = "relay_settings"
        const val KEY_RELAY_URL = "relay_url"
    }
}
