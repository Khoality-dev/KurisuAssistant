"""The residency scheduler (#207), against fake models and a manual clock."""

import pytest

from universal_voice.scheduler import OFFLOADED, RESIDENT, UNLOADED, ModelInUse, ModelScheduler


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class FakeModel:
    def __init__(self, model_id, offloadable=True):
        self.model_id = model_id
        self.offloadable = offloadable
        self.ops: list[str] = []

    def load(self):
        self.ops.append("load")

    def offload(self):
        self.ops.append("offload")
        return self.offloadable

    def unload(self):
        self.ops.append("unload")


@pytest.fixture
def clock():
    return Clock()


def make(clock, **kw):
    defaults = dict(max_resident_tts=1, offload_after=300, unload_after=1800, clock=clock)
    defaults.update(kw)
    return ModelScheduler(**defaults)


def state(s, model, kind="tts"):
    return s.status()[f"{kind}:{model.model_id}"]["residency"]


def test_use_loads_once_and_keeps_the_model_resident(clock):
    s = make(clock)
    a = FakeModel("a")
    with s.use(a):
        assert state(s, a) == RESIDENT
    with s.use(a):
        pass
    assert a.ops == ["load"]
    assert state(s, a) == RESIDENT


def test_cap_offloads_the_least_recently_used_model(clock):
    s = make(clock, max_resident_tts=1)
    a, b = FakeModel("a"), FakeModel("b")
    with s.use(a):
        pass
    clock.advance(1)
    with s.use(b):
        assert state(s, a) == OFFLOADED
        assert state(s, b) == RESIDENT
    assert a.ops == ["load", "offload"]
    # And back again: the backend's load() is what brings it from CPU memory.
    with s.use(a):
        assert state(s, a) == RESIDENT
        assert state(s, b) == OFFLOADED
    assert a.ops == ["load", "offload", "load"]


def test_cap_unloads_a_model_that_cannot_offload(clock):
    s = make(clock, max_resident_tts=1)
    a, b = FakeModel("a", offloadable=False), FakeModel("b")
    with s.use(a):
        pass
    with s.use(b):
        pass
    # offload() answered False: the model stays resident rather than lying about its state.
    assert state(s, a) == RESIDENT
    assert a.ops == ["load", "offload"]


def test_a_model_in_use_is_never_evicted(clock):
    s = make(clock, max_resident_tts=1)
    a, b = FakeModel("a"), FakeModel("b")
    with s.use(a):
        with s.use(b):
            assert state(s, a) == RESIDENT
            assert state(s, b) == RESIDENT
    assert a.ops == ["load"]


def test_cap_zero_means_no_cap(clock):
    s = make(clock, max_resident_tts=0)
    models = [FakeModel(str(i)) for i in range(4)]
    for m in models:
        with s.use(m):
            pass
    assert all(state(s, m) == RESIDENT for m in models)


def test_sweep_offloads_then_unloads_by_idle_time(clock):
    s = make(clock, offload_after=300, unload_after=1800)
    a = FakeModel("a")
    with s.use(a):
        pass
    clock.advance(299)
    s.sweep()
    assert state(s, a) == RESIDENT
    clock.advance(2)
    s.sweep()
    assert state(s, a) == OFFLOADED
    clock.advance(1500)
    s.sweep()
    assert state(s, a) == UNLOADED
    assert a.ops == ["load", "offload", "unload"]
    s.sweep()  # nothing left to do
    assert a.ops == ["load", "offload", "unload"]


def test_sweep_skips_a_model_in_use(clock):
    s = make(clock, offload_after=10, unload_after=20)
    a = FakeModel("a")
    with s.use(a):
        clock.advance(100)
        s.sweep()
        assert state(s, a) == RESIDENT
    assert a.ops == ["load"]


def test_a_model_that_cannot_offload_waits_for_the_unload_threshold(clock):
    s = make(clock, offload_after=10, unload_after=20)
    a = FakeModel("a", offloadable=False)
    with s.use(a):
        pass
    clock.advance(15)
    s.sweep()
    assert state(s, a) == RESIDENT
    clock.advance(10)
    s.sweep()
    assert state(s, a) == UNLOADED


def test_zero_thresholds_disable_the_sweeper(clock):
    s = make(clock, offload_after=0, unload_after=0)
    a = FakeModel("a")
    with s.use(a):
        pass
    clock.advance(10**6)
    s.sweep()
    assert state(s, a) == RESIDENT


def test_asr_models_are_not_counted_against_the_tts_cap(clock):
    s = make(clock, max_resident_tts=1)
    whisper, tts = FakeModel("base", offloadable=False), FakeModel("vixtts")
    with s.use(whisper, kind="asr"):
        pass
    with s.use(tts):
        pass
    assert state(s, whisper, "asr") == RESIDENT
    assert state(s, tts) == RESIDENT
    clock.advance(2000)
    s.sweep()
    assert state(s, whisper, "asr") == UNLOADED


def test_status_reports_idle_time_and_use(clock):
    s = make(clock)
    a = FakeModel("a")
    with s.use(a):
        assert s.status()["tts:a"]["in_use"] == 1
        assert s.status()["tts:a"]["idle_seconds"] == 0
    clock.advance(42)
    assert s.status()["tts:a"] == {"residency": RESIDENT, "idle_seconds": 42, "in_use": 0, "can_offload": False}


def test_preload_brings_a_model_in_and_leaves_it_idle(clock):
    s = make(clock)
    a = FakeModel("a")
    s.preload(a)
    assert state(s, a) == RESIDENT and a.ops == ["load"]
    assert s.status()["tts:a"]["in_use"] == 0


# --- on request (#218) --------------------------------------------------------

def test_load_brings_a_model_in_and_leaves_it_idle(clock):
    s = make(clock)
    a = FakeModel("a")
    assert s.load(a) == RESIDENT
    assert a.ops == ["load"]
    assert s.status()["tts:a"]["in_use"] == 0


def test_load_respects_the_cap_like_a_request(clock):
    s = make(clock, max_resident_tts=1)
    a, b = FakeModel("a"), FakeModel("b")
    s.load(a)
    s.load(b)
    assert state(s, a) == OFFLOADED
    assert state(s, b) == RESIDENT


def test_offload_and_unload_on_request(clock):
    s = make(clock)
    a = FakeModel("a")
    s.load(a)
    assert s.offload(a) == OFFLOADED
    assert s.unload(a) == UNLOADED
    assert a.ops == ["load", "offload", "unload"]


def test_a_model_in_use_refuses_to_be_parked(clock):
    s = make(clock)
    a = FakeModel("a")
    with s.use(a):
        with pytest.raises(ModelInUse) as excinfo:
            s.offload(a)
        with pytest.raises(ModelInUse):
            s.unload(a)
    assert excinfo.value.key == "tts:a"
    assert excinfo.value.in_use == 1
    assert a.ops == ["load"]
    assert state(s, a) == RESIDENT


def test_offload_leaves_a_model_that_cannot_offload_where_it_is(clock):
    s = make(clock)
    a = FakeModel("a", offloadable=False)
    s.load(a)
    assert s.offload(a) == RESIDENT
    assert state(s, a) == RESIDENT


def test_offloading_an_unloaded_model_is_a_no_op(clock):
    s = make(clock)
    a = FakeModel("a")
    assert s.offload(a) == UNLOADED
    assert s.unload(a) == UNLOADED
    assert a.ops == []


def test_status_reports_whether_a_model_can_offload(clock):
    s = make(clock)
    a = FakeModel("a")
    a.can_offload = True
    b = FakeModel("b")  # says nothing about it
    s.register(a)
    s.register(b)
    assert s.status()["tts:a"]["can_offload"] is True
    assert s.status()["tts:b"]["can_offload"] is False
