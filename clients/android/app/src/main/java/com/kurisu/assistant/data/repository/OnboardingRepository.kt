package com.kurisu.assistant.data.repository

import com.kurisu.assistant.data.model.ModelsResponse
import com.kurisu.assistant.data.remote.api.KurisuApiService
import com.kurisu.assistant.domain.onboarding.OnboardingApi
import kotlinx.serialization.json.JsonObject
import javax.inject.Inject
import javax.inject.Singleton

/** Onboarding's calls (#342), against the real API. */
@Singleton
class OnboardingRepository @Inject constructor(
    private val api: KurisuApiService,
) : OnboardingApi {

    /** Whether the server says this account is owed its onboarding. */
    suspend fun isPending(): Boolean = api.getUserProfile().onboardingPending

    override suspend fun patchProfile(body: JsonObject) {
        api.patchUserProfile(body)
    }

    override suspend fun models(): ModelsResponse = api.getModels()

    override suspend fun patchAssistant(body: JsonObject) {
        api.patchAssistant(body)
    }
}
