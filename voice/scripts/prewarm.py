"""Run at image build: do once, into the image, what the vendored GPT-SoVITS
text frontends otherwise do at first use in the running container.

Each import below downloads or compiles something on first use — the Open JTalk
dictionary, NLTK's tagger and CMU dictionary, the Japanese user dictionary
(compiled from userdict.csv), the English and polyphone pickles, the
fast_langdetect model. Doing it here means a fresh container speaks without
first fetching from four different places, and a container with no outbound
network still speaks. Model weights are not touched: they go to the data volume
on first use (universal_voice/tts/*_model.py).

Deliberately independent of the universal_voice package, so a code change does
not invalidate this layer of the image.
"""

import sys
from pathlib import Path

VENDOR = Path(__file__).resolve().parents[1] / "vendor" / "gpt_sovits"
for entry in (VENDOR / "GPT_SoVITS", VENDOR):
    sys.path.insert(0, str(entry))


def main() -> None:
    import nltk

    for package in ("averaged_perceptron_tagger", "averaged_perceptron_tagger_eng", "cmudict"):
        nltk.download(package, quiet=True)
    print("nltk data ready")

    import pyopenjtalk

    pyopenjtalk.g2p("こんにちは")  # fetches the Open JTalk dictionary on first call
    print("open_jtalk dictionary ready")

    import text.japanese  # noqa: F401 — compiles ja_userdic/userdict.csv into user.dict

    print("japanese user dictionary ready")

    import text.english  # noqa: F401 — writes engdict_cache.pickle from cmudict.rep

    print("english dictionary cache ready")

    import text.g2pw.g2pw  # noqa: F401 — writes g2pw/polyphonic.pickle

    print("polyphone cache ready")

    # fast_langdetect downloads into a directory it will not create; upstream
    # ships an empty pretrained_models/ that the vendored tree does not carry.
    (VENDOR / "GPT_SoVITS" / "pretrained_models" / "fast_langdetect").mkdir(parents=True, exist_ok=True)
    from text.LangSegmenter import LangSegmenter

    LangSegmenter.getTexts("Hello, 世界。こんにちは")  # fetches the fast_langdetect model
    print("language segmenter ready")


if __name__ == "__main__":
    main()
