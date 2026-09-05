package com.kurisu.assistant.data.local

object StorageKeys {
    const val AUTH_TOKEN = "kurisu_auth_token"
    const val REMEMBER_ME = "kurisu_remember_me"
    const val TTS_VOICE = "kurisu_tts_voice"
    const val TTS_LANGUAGE = "kurisu_tts_language"
    const val TTS_AUTO_PLAY = "kurisu_tts_auto_play"
    const val TTS_BACKEND = "kurisu_tts_backend"
    const val TTS_EMO_AUDIO = "kurisu_tts_emo_audio"
    const val TTS_EMO_ALPHA = "kurisu_tts_emo_alpha"
    const val TTS_USE_EMO_TEXT = "kurisu_tts_use_emo_text"
    const val BACKEND_URL = "kurisu_backend_url"
    // There is exactly one assistant, so there is nothing to select locally, and
    // the default persona lives on the assistant row server-side — two devices
    // would otherwise disagree about who answers. `kurisu_selected_agent_id` is
    // gone rather than renamed.
    //
    // Persona -> last conversation. A cache: it re-derives from the backend on a
    // miss, so the rename needs no migration; a stale `kurisu_agent_conversations`
    // blob is simply never read again.
    const val PERSONA_CONVERSATIONS = "kurisu_persona_conversations"
    const val AUDIO_INPUT_DEVICE_TYPE = "kurisu_audio_input_device_type"
    const val ASR_LANGUAGE = "kurisu_asr_language"
    const val ASR_ALWAYS_LISTEN = "kurisu_asr_always_listen"
    const val REFRESH_TOKEN = "kurisu_refresh_token"
    const val THEME_MODE = "kurisu_theme_mode"
    const val TTS_AUTO_PLAY_SETTING = "kurisu_tts_auto_play_setting"
    const val ASR_MODE = "kurisu_asr_mode"
    const val ASR_FIXED_MODEL = "kurisu_asr_fixed_model"
    const val ASR_MODEL_MAP = "kurisu_asr_model_map"
    const val SPEAKER_DEVICE_ID = "kurisu_speaker_device_id"
    const val AUTO_UPDATE = "kurisu_auto_update"
}
