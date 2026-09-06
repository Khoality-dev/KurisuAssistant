"""Gesture detection picks its device instead of assuming a GPU (#152)."""

import logging
import sys
import types

import pytest

from kurisuassistant.models.gesture_detection import mediapipe_provider


@pytest.fixture()
def torch(monkeypatch):
    """A stand-in ``torch`` whose CUDA answer the test controls."""
    fake = types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: False))
    monkeypatch.setitem(sys.modules, "torch", fake)
    monkeypatch.delenv("VISION_DEVICE", raising=False)
    return fake


def test_cpu_when_torch_sees_no_gpu(torch, caplog):
    with caplog.at_level(logging.INFO, logger=mediapipe_provider.__name__):
        assert mediapipe_provider.resolve_device() == "cpu"
    assert "cpu" in caplog.text and "no CUDA device" in caplog.text


def test_cuda_when_torch_sees_one(torch, caplog):
    torch.cuda.is_available = lambda: True
    with caplog.at_level(logging.INFO, logger=mediapipe_provider.__name__):
        assert mediapipe_provider.resolve_device() == "cuda"
    assert "Gesture detection device: cuda" in caplog.text


def test_the_environment_overrides(torch, monkeypatch):
    torch.cuda.is_available = lambda: True
    monkeypatch.setenv("VISION_DEVICE", "cpu")
    assert mediapipe_provider.resolve_device() == "cpu"


def test_forcing_cuda_without_one_falls_back_and_warns(torch, monkeypatch, caplog):
    monkeypatch.setenv("VISION_DEVICE", "cuda")
    with caplog.at_level(logging.WARNING, logger=mediapipe_provider.__name__):
        assert mediapipe_provider.resolve_device() == "cpu"
    assert "VISION_DEVICE=cuda" in caplog.text


def test_no_torch_at_all_means_cpu(monkeypatch):
    monkeypatch.setitem(sys.modules, "torch", None)  # import raises
    monkeypatch.delenv("VISION_DEVICE", raising=False)
    assert mediapipe_provider.resolve_device() == "cpu"


def test_the_detector_resolves_once(torch, monkeypatch):
    calls = []
    monkeypatch.setattr(mediapipe_provider, "resolve_device", lambda: calls.append(1) or "cpu")
    detector = mediapipe_provider.MediaPipeGestureDetector()
    assert detector.device == "cpu"
    assert detector.device == "cpu"
    assert len(calls) == 1


def test_nothing_is_hard_coded_to_cuda():
    source = open(mediapipe_provider.__file__).read()
    assert 'device="cuda"' not in source
