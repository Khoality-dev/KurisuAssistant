"""Split text into passages the retrieval index can store and quote (#6).

A passage is a verbatim slice of the source — the recall tools quote what was
said or written, so nothing here rewrites, normalises or trims inside a slice.
What this module decides is *where* to cut:

- paragraphs first (a blank line), then sentences, then a hard cut at a space,
  so a slice ends where a reader would pause rather than mid-word;
- about ``target`` characters per passage (~300 tokens: small enough that a
  handful fit in a tool result, big enough to carry a whole thought);
- consecutive passages overlap by about ``overlap`` characters, so a sentence
  that straddles a cut is whole in one of them.

Every ``Chunk`` carries its character offsets and 1-based line range in the
source, which is what lets a citation say "lines 40–58" of a file. Offsets are
into the text as given; callers that extract per page pass one page at a time.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import List, Tuple

DEFAULT_TARGET = 1200
DEFAULT_OVERLAP = 200

_PARAGRAPH = re.compile(r"\n[ \t]*\n")
# A sentence end: terminal punctuation (Latin or CJK) followed by whitespace.
_SENTENCE = re.compile(r"(?<=[.!?…。！？])\s+")


@dataclass(frozen=True)
class Chunk:
    text: str
    start_offset: int
    end_offset: int
    start_line: int
    end_line: int


def _spans(text: str, pattern: re.Pattern, start: int, end: int) -> List[Tuple[int, int]]:
    """Non-empty spans of ``text[start:end]`` between matches of ``pattern``."""
    spans = []
    pos = start
    for m in pattern.finditer(text, start, end):
        if m.start() > pos:
            spans.append((pos, m.start()))
        pos = m.end()
    if end > pos:
        spans.append((pos, end))
    return [(s, e) for s, e in spans if text[s:e].strip()]


def _hard(text: str, start: int, end: int, target: int) -> List[Tuple[int, int]]:
    """Cut an over-long run at a line end, else a space, in the second half of
    the window — so line-oriented text (code, lists, tables) cuts between lines
    and prose cuts between words."""
    out = []
    pos = start
    while end - pos > target:
        cut = text.rfind("\n", pos + target // 2, pos + target)
        if cut == -1:
            cut = text.rfind(" ", pos + target // 2, pos + target)
        if cut == -1:
            cut = pos + target
        out.append((pos, cut))
        pos = cut
        while pos < end and text[pos].isspace():
            pos += 1
    if pos < end:
        out.append((pos, end))
    return out


def _units(text: str, target: int) -> List[Tuple[int, int]]:
    """The smallest pieces a passage is assembled from, each at most ``target``."""
    units: List[Tuple[int, int]] = []
    for ps, pe in _spans(text, _PARAGRAPH, 0, len(text)):
        if pe - ps <= target:
            units.append((ps, pe))
            continue
        for ss, se in _spans(text, _SENTENCE, ps, pe):
            if se - ss <= target:
                units.append((ss, se))
            else:
                units.extend(_hard(text, ss, se, target))
    return units


def _make(text: str, start: int, end: int) -> Chunk:
    # Trim whitespace at the edges — but by moving the offsets, so the text
    # stays an exact slice of the source.
    while start < end and text[start].isspace():
        start += 1
    while end > start and text[end - 1].isspace():
        end -= 1
    return Chunk(
        text=text[start:end],
        start_offset=start,
        end_offset=end,
        start_line=text.count("\n", 0, start) + 1,
        end_line=text.count("\n", 0, max(end - 1, start)) + 1,
    )


def chunk_text(
    text: str,
    target: int = DEFAULT_TARGET,
    overlap: int = DEFAULT_OVERLAP,
) -> List[Chunk]:
    """Cut ``text`` into overlapping passages of about ``target`` characters.

    Returns an empty list for blank input. Every chunk is a verbatim slice; the
    union of the chunks covers every non-blank character of the input.
    """
    if not text or not text.strip():
        return []
    if target <= 0:
        raise ValueError("target must be positive")
    overlap = max(0, min(overlap, target // 2))

    units = _units(text, target)
    if not units:
        return []

    chunks: List[Chunk] = []
    i = 0
    n = len(units)
    while i < n:
        j = i
        while j + 1 < n and units[j + 1][1] - units[i][0] <= target:
            j += 1
        chunks.append(_make(text, units[i][0], units[j][1]))
        if j + 1 >= n:
            break
        # Start the next passage a little before this one ended: step back over
        # trailing units while they fit in the overlap budget, never back to
        # where this passage began, so every step makes progress.
        k = j + 1
        covered = 0
        while k - 1 > i:
            size = units[k - 1][1] - units[k - 1][0]
            if covered + size > overlap:
                break
            covered += size
            k -= 1
        i = k
    return chunks
