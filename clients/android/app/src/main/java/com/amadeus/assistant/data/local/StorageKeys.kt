package com.amadeus.assistant.data.local

object StorageKeys {
    const val AUTH_TOKEN = "amadeus_auth_token"
    const val REMEMBER_ME = "amadeus_remember_me"
    const val TTS_VOICE = "amadeus_tts_voice"
    const val TTS_LANGUAGE = "amadeus_tts_language"
    const val TTS_AUTO_PLAY = "amadeus_tts_auto_play"
    const val TTS_BACKEND = "amadeus_tts_backend"
    const val BACKEND_URL = "amadeus_backend_url"
    // There is exactly one assistant, so there is nothing to select locally, and
    // the persona in use lives on the assistant row server-side — two devices
    // would otherwise disagree about who answers. `kurisu_selected_agent_id` is
    // gone rather than renamed. So is `kurisu_persona_conversations`, the "last
    // conversation per persona" cache: a conversation is not tied to a persona
    // (#354), and `PersonaConversationsRemoval` deletes it from the store.
    const val AUDIO_INPUT_DEVICE_TYPE = "amadeus_audio_input_device_type"
    const val ASR_LANGUAGE = "amadeus_asr_language"
    // Voice mode on or off, remembered on this device: the desktop's key (#341).
    // It replaced "Always listen" (`kurisu_asr_always_listen`), which
    // `AlwaysListenRemoval` deletes from the store.
    const val VOICE_MODE = "amadeus_voice_mode"
    const val REFRESH_TOKEN = "amadeus_refresh_token"
    const val THEME_MODE = "amadeus_theme_mode"
    const val TTS_AUTO_PLAY_SETTING = "amadeus_tts_auto_play_setting"
    const val ASR_MODE = "amadeus_asr_mode"
    const val ASR_FIXED_MODEL = "amadeus_asr_fixed_model"
    const val ASR_MODEL_MAP = "amadeus_asr_model_map"
    const val SPEAKER_DEVICE_ID = "amadeus_speaker_device_id"
    const val AUTO_UPDATE = "amadeus_auto_update"
    /** Notifications on this phone (#353); on unless `false`. */
    const val NOTIFICATIONS_ENABLED = "amadeus_notifications_enabled"
    /** Which notifications this phone has posted, per server, as a JSON `{server URL: [id, …]}`. */
    const val NOTIFICATIONS_SHOWN = "amadeus_notifications_shown"
    /** The FCM token this phone registered with the server for push (#353), until it unregisters. */
    const val PUSH_TOKEN = "amadeus_push_token"
}
