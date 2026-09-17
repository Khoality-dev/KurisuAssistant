"""The transcriber's bookkeeping, short of loading a Whisper model: one model is
one entry whatever spelling names it (#218)."""

from universal_voice.models.transcriber import Transcriber


def test_a_handle_is_keyed_by_the_cache_id_whatever_spelling_names_it():
    t = Transcriber()
    by_name = t.handle("vinai/PhoWhisper-base")
    by_id = t.handle("vinai_PhoWhisper-base")
    assert by_name is by_id
    assert by_name.model_id == "vinai_PhoWhisper-base"
    # The name that first asked is what a download needs.
    assert by_name.source == "vinai/PhoWhisper-base"
    assert by_name.can_offload is False


def test_loaded_models_and_unload_use_the_cache_id():
    t = Transcriber()
    t._models["vinai_PhoWhisper-base"] = object()
    assert t.loaded_models() == ["vinai_PhoWhisper-base"]
    assert t.unload_model("vinai/PhoWhisper-base") is True
    assert t.loaded_models() == []
