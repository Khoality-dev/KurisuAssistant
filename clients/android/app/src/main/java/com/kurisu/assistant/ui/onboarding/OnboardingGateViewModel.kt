package com.kurisu.assistant.ui.onboarding

import androidx.lifecycle.ViewModel
import com.kurisu.assistant.data.repository.OnboardingRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject

/**
 * Whether to offer onboarding (#342) as the app opens. The server decides —
 * owed until finished or skipped on some device, never with a persona — and a
 * profile that cannot be read lets the app through rather than locking it.
 */
@HiltViewModel
class OnboardingGateViewModel @Inject constructor(
    private val repo: OnboardingRepository,
) : ViewModel() {
    suspend fun isPending(): Boolean = runCatching { repo.isPending() }.getOrDefault(false)
}
