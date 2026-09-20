"""How well a real model follows the ``## Expression`` prompt (#243). By hand only.

Twenty short prompts against the live model at ``LLM_API_URL`` (an Ollama;
``EMOTION_TEST_MODEL`` picks the model, default ``qwen3:8b``). For each reply it
prints where the tags landed — at the start of a sentence, mid-sentence, on
every sentence, unknown labels — and ends with a summary. Nothing here is
asserted beyond "the model answered": the point is the printout, read by a
person deciding whether the prompt wording or a model is good enough.

Marked ``integration``: it talks to a real model, which costs time or money,
so CI never runs it. Run from ``backend/`` with

    pytest tests/test_emotion_compliance.py -m integration -s

The stripper's own behaviour is pinned in ``test_emotion_tags.py``; this file
measures the model, not the code.
"""

import json
import os
import re

import pytest

from kurisuassistant.agents.main import EXPRESSION_PROMPT
from kurisuassistant.character.emotion_source import EMOTION_LABELS

pytestmark = pytest.mark.integration

PROMPTS = [
    "Hi! How are you today?",
    "I just got promoted at work.",
    "My cat died this morning.",
    "Someone scratched my car in the parking lot and drove off.",
    "Tell me a fun fact about octopuses.",
    "I can't sleep. Any advice?",
    "You won't believe it — I found my old diary from ten years ago.",
    "What's 17 times 23?",
    "I'm bored. Entertain me.",
    "My friend cancelled our plans again. Third time this month.",
    "Describe a quiet evening by the sea.",
    "I think I failed my exam.",
    "We're getting a puppy next week!",
    "Explain what a mutex is, briefly.",
    "Someone said you're just a program. Thoughts?",
    "I made your favourite dish tonight.",
    "The weather is awful and my umbrella broke.",
    "Guess what I'm holding behind my back.",
    "Say goodnight to me.",
    "Rant with me about slow wifi.",
]

TAG = re.compile(r"\[\[emotion:([a-z]+)\]\]")


def classify(reply: str) -> dict:
    """Where each tag sits: sentence start, mid-sentence, or an unknown label."""
    sentences = [s for s in re.split(r"(?<=[.!?])\s+", reply.strip()) if s]
    at_start = sum(1 for s in sentences if TAG.match(s))
    tags = TAG.findall(reply)
    unknown = [t for t in tags if t not in EMOTION_LABELS]
    return {
        "tags": len(tags),
        "at_sentence_start": at_start,
        "mid_sentence": len(tags) - at_start,
        "sentences": len(sentences),
        "every_sentence": bool(sentences) and at_start == len(sentences),
        "unknown": unknown,
    }


def test_tag_placement_against_the_live_model():
    import httpx

    url = os.environ.get("LLM_API_URL", "http://localhost:11434").rstrip("/")
    model = os.environ.get("EMOTION_TEST_MODEL", "qwen3:8b")
    system = "You are Kurisu, a warm and slightly sarcastic assistant.\n\n" + EXPRESSION_PROMPT

    totals = {"replies": 0, "tags": 0, "at_sentence_start": 0, "mid_sentence": 0, "every_sentence": 0, "untagged": 0, "unknown": []}
    with httpx.Client(timeout=120) as client:
        for prompt in PROMPTS:
            resp = client.post(
                f"{url}/api/chat",
                json={"model": model, "stream": False, "think": False,
                      "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}]},
            )
            resp.raise_for_status()
            reply = resp.json()["message"]["content"]
            shape = classify(reply)
            totals["replies"] += 1
            totals["tags"] += shape["tags"]
            totals["at_sentence_start"] += shape["at_sentence_start"]
            totals["mid_sentence"] += shape["mid_sentence"]
            totals["every_sentence"] += int(shape["every_sentence"])
            totals["untagged"] += int(shape["tags"] == 0)
            totals["unknown"] += shape["unknown"]
            print(f"\n> {prompt}\n{reply.strip()}\n  {json.dumps(shape)}")

    print("\n== summary ==\n" + json.dumps(totals, indent=1))
    assert totals["replies"] == len(PROMPTS)
