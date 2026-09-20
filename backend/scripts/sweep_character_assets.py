"""List — and, on request, remove — character asset directories that belong to no persona.

``data/character_assets/{persona_id}/`` is removed when its persona is deleted
(#234), but nothing did that before, and a database restored from an older
backup or two checkouts sharing ``backend/data/`` can leave directories whose
persona no longer exists. This is an operator script, not a migration, because
a migration that deletes directories is the one upgrade step that can destroy
art the restored rows still point at.

    python -m scripts.sweep_character_assets            # dry run: list only
    python -m scripts.sweep_character_assets --apply    # remove the orphans

Only directories named by a number that is not a live ``personas.id`` are
orphans. Anything else under the root — a name that is not a number — is listed
as unrecognised and never touched, whatever the flag.
"""

from __future__ import annotations

import argparse
import logging
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path

import dotenv

# db.session reads POSTGRES_* at import time, so the environment file has to be
# loaded before anything under kurisuassistant.db is imported (as scripts.migrate).
dotenv.load_dotenv()

from kurisuassistant.character import paths  # noqa: E402
from kurisuassistant.character.references import directory_bytes  # noqa: E402

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Sweep:
    """What one pass over the root found."""

    orphans: list[tuple[Path, int]]  # directory, bytes it holds
    unrecognised: list[Path]


def find_orphans(root: Path, live_ids: set[int]) -> Sweep:
    """Classify every directory directly under ``root``. Pure: reads sizes, deletes nothing."""
    orphans: list[tuple[Path, int]] = []
    unrecognised: list[Path] = []
    if not root.exists():
        return Sweep(orphans, unrecognised)
    for entry in sorted(root.iterdir()):
        if not entry.is_dir():
            unrecognised.append(entry)
            continue
        if not entry.name.isdigit():
            unrecognised.append(entry)
            continue
        if int(entry.name) in live_ids:
            continue
        orphans.append((entry, directory_bytes(entry)))
    return Sweep(orphans, unrecognised)


def sweep(root: Path, live_ids: set[int], apply: bool, out=sys.stdout) -> Sweep:
    """Print the classification; remove the orphans only when ``apply`` is set."""
    found = find_orphans(root, live_ids)
    verb = "removing" if apply else "would remove"
    for directory, size in found.orphans:
        print(f"{verb} {directory}  ({size} bytes)", file=out)
        if apply:
            shutil.rmtree(directory, ignore_errors=True)
    for entry in found.unrecognised:
        print(f"unrecognised, left alone: {entry}", file=out)
    total = sum(size for _, size in found.orphans)
    if not found.orphans:
        print("no orphaned character asset directories", file=out)
    elif apply:
        print(f"removed {len(found.orphans)} directories, {total} bytes", file=out)
    else:
        print(f"{len(found.orphans)} directories, {total} bytes — run again with --apply to remove them", file=out)
    return found


def live_persona_ids() -> set[int]:
    """Every ``personas.id`` in the configured database."""
    from sqlalchemy import select

    from kurisuassistant.db.models import Persona
    from kurisuassistant.db.session import get_session

    with get_session() as session:
        return {row[0] for row in session.execute(select(Persona.id))}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--apply", action="store_true", help="remove the orphans instead of listing them")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    sweep(paths.CHAR_ASSETS_DIR, live_persona_ids(), apply=args.apply)
    return 0


if __name__ == "__main__":
    sys.exit(main())
