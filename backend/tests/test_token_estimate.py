"""What the context counter counts (#99).

The old estimate was ``words * 1.3`` over ``content``, which charged nothing for
an image, nothing for a tool call's arguments, nothing for a thinking block and
nothing for message framing — while driving both the compaction trigger and the
number the user watches. These tests pin the parts that were free.
"""

import json

import pytest

from kurisuassistant.utils.tokens import (
    CHARS_PER_TOKEN,
    PER_MESSAGE_OVERHEAD_TOKENS,
    TOKENS_PER_IMAGE,
    chars_to_tokens,
    estimate_message_tokens,
    estimate_text_tokens,
    estimate_tokens,
)


def words(n: int) -> str:
    return " ".join(["word"] * n)


class TestText:
    def test_empty_is_free(self):
        assert estimate_text_tokens("") == 0
        assert estimate_text_tokens(None) == 0
        assert chars_to_tokens(0) == 0

    def test_it_rounds_up(self):
        assert estimate_text_tokens("a") == 1
        assert estimate_text_tokens("a" * CHARS_PER_TOKEN) == 1
        assert estimate_text_tokens("a" * (CHARS_PER_TOKEN + 1)) == 2

    def test_a_run_of_text_is_measured_by_length_not_by_spaces(self):
        """Code, paths and JSON have few spaces and many tokens; the word count
        read them as almost free."""
        dense = "conversation_id=12345;path=/var/lib/kurisu/data/image_storage/x.png"
        assert estimate_text_tokens(dense) > len(dense.split()) * 1.3

    def test_a_language_without_spaces_is_not_one_token(self):
        japanese = "これは日本語の文章です。" * 10
        assert estimate_text_tokens(japanese) >= 30


class TestTheThingsThatUsedToBeFree:
    def test_an_image_costs_something(self):
        text_only = {"role": "user", "content": "look"}
        with_image = {"role": "user", "content": "look", "images": ["uuid-a"]}
        assert estimate_message_tokens(with_image) - estimate_message_tokens(text_only) == TOKENS_PER_IMAGE

    def test_images_are_counted_per_image_not_per_character(self):
        """An identifier and a megabyte of base64 are the same one picture."""
        by_uuid = {"role": "user", "content": "", "images": ["u"]}
        by_base64 = {"role": "user", "content": "", "images": ["A" * 2_000_000]}
        assert estimate_message_tokens(by_uuid) == estimate_message_tokens(by_base64)

    def test_three_images_cost_three(self):
        one = {"role": "user", "content": "", "images": ["a"]}
        three = {"role": "user", "content": "", "images": ["a", "b", "c"]}
        assert estimate_message_tokens(three) - estimate_message_tokens(one) == 2 * TOKENS_PER_IMAGE

    def test_tool_arguments_are_counted(self):
        args = {"path": "/etc/hosts", "pattern": "x" * 400}
        call = {"function": {"name": "grep", "arguments": args}}
        bare = {"role": "assistant", "content": ""}
        with_call = {"role": "assistant", "content": "", "tool_calls": [call]}
        expected = estimate_text_tokens(json.dumps([call], ensure_ascii=False, default=str))
        assert estimate_message_tokens(with_call) - estimate_message_tokens(bare) == expected

    def test_a_tool_result_is_counted(self):
        result = {"role": "tool", "name": "grep", "content": "x" * 4000}
        assert estimate_message_tokens(result) >= 1000

    def test_thinking_is_counted(self):
        plain = {"role": "assistant", "content": "yes"}
        thinking = {"role": "assistant", "content": "yes", "thinking": "y" * 800}
        assert estimate_message_tokens(thinking) - estimate_message_tokens(plain) == 200

    def test_unserializable_arguments_do_not_raise(self):
        call = [{"function": {"name": "x", "arguments": {"f": object()}}}]
        assert estimate_message_tokens({"role": "assistant", "tool_calls": call}) > 0


class TestWholeLists:
    def test_every_message_carries_framing(self):
        messages = [{"role": "user", "content": ""} for _ in range(10)]
        # role ("user" = 4 chars = 1 token) plus the per-message overhead.
        assert estimate_tokens(messages) == 10 * (PER_MESSAGE_OVERHEAD_TOKENS + 1)

    def test_empty_and_none_are_zero(self):
        assert estimate_tokens([]) == 0
        assert estimate_tokens(None) == 0

    def test_a_picture_heavy_conversation_is_no_longer_read_as_nearly_empty(self):
        """The failure the issue describes: images and tool payloads made the
        estimate a large multiple too small, in the direction that overruns."""
        conversation = []
        for _ in range(10):
            conversation.append({"role": "user", "content": "what is this", "images": ["u"]})
            conversation.append({
                "role": "assistant", "content": "",
                "tool_calls": [{"function": {"name": "look", "arguments": {"q": "x" * 200}}}],
            })
            conversation.append({"role": "tool", "name": "look", "content": "y" * 2000})

        old_style = int(sum(len(m.get("content", "").split()) for m in conversation) * 1.3)
        assert estimate_tokens(conversation) > 10 * old_style

    def test_it_errs_high_rather_than_low(self):
        """A summary that fires early costs one call; one that fires late costs
        the turn — so the estimate is allowed to exceed a plain 4-chars-per-token
        reading of the same text, never fall short of it."""
        messages = [{"role": "user", "content": words(500)}]
        floor = estimate_text_tokens(messages[0]["content"])
        assert estimate_tokens(messages) >= floor
