"""Fetch the GPT-SoVITS data files that are too large to commit.

Run at image build (see the Dockerfile) and, for a local checkout, by hand. Each
file comes from the pinned upstream commit the vendored code was taken from and
is checked against its SHA-256, so the build is reproducible and a corrupted
download is an error, not a silently wrong dictionary. Files already present
with the right hash are left alone. See vendor/gpt_sovits/PATCHES.md.
"""

import hashlib
import sys
import urllib.request
from pathlib import Path

UPSTREAM_COMMIT = "ad7df5298bea51273c86c05b5b13f28ed7d9fe16"
BASE_URL = f"https://raw.githubusercontent.com/RVC-Boss/GPT-SoVITS/{UPSTREAM_COMMIT}/"
VENDOR = Path(__file__).resolve().parents[1] / "vendor" / "gpt_sovits"

FILES = {
    "GPT_SoVITS/text/ja_userdic/userdict.csv": "d857e443ee48d9641096816a98996669602895411e4330d7d91d1dbe1103389f",
    "GPT_SoVITS/text/cmudict.rep": "0e601d017d6e6f958443d41cd8922b4cd7598b3ba2056253a33f3e5a35f38494",
    "GPT_SoVITS/text/cmudict-fast.rep": "53bfef0f27d7dd74d1ba74563d1e076d3e0672ce3596cb2d6c0d52ac9ad01f6d",
    "GPT_SoVITS/text/g2pw/polyphonic-fix.rep": "6444b2ad4a1070dad9b16c7e47271910a69349ff079e8d8e236c8818209b65f4",
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    for relative, expected in FILES.items():
        target = VENDOR / relative
        if target.exists() and sha256(target) == expected:
            print(f"ok       {relative}")
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        url = BASE_URL + relative
        print(f"fetching {relative}")
        tmp = target.with_suffix(target.suffix + ".part")
        with urllib.request.urlopen(url, timeout=120) as response, tmp.open("wb") as out:
            while True:
                chunk = response.read(1 << 20)
                if not chunk:
                    break
                out.write(chunk)
        actual = sha256(tmp)
        if actual != expected:
            tmp.unlink(missing_ok=True)
            print(f"checksum mismatch for {relative}: expected {expected}, got {actual}", file=sys.stderr)
            return 1
        tmp.replace(target)
    return 0


if __name__ == "__main__":
    sys.exit(main())
