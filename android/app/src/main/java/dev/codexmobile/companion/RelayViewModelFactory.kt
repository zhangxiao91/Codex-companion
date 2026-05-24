package dev.codexmobile.companion

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider

class RelayViewModelFactory(
    context: Context
) : ViewModelProvider.Factory {
    private val settings = RelaySettings(context.applicationContext)
    private val cacheStore = RelayCacheStore(context.applicationContext)

    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        if (modelClass.isAssignableFrom(RelayViewModel::class.java)) {
            @Suppress("UNCHECKED_CAST")
            return RelayViewModel(settings, cacheStore) as T
        }

        throw IllegalArgumentException("Unknown ViewModel class: ${modelClass.name}")
    }
}
