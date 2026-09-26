"""List — and, on request, remove — character asset directories that belong to no persona.

``data/character_assets/{persona_id}/`` is removed when its persona is deleted
(#234), but nothing did that before, and a database restored from an older
backup or two checkouts sharing ``backend/data/`` can leave directories whose
persona no longer exists. This is an operator script, not a migration, because
a migration that deletes directories is the one upgrade step that can destroy
art the restored rows still point at.

    python -m scripts.sweep_character_assets            # dry run: list only
    python -m scripts.sweep_character_assets --apply    # remove the orphans

Only directories whose name is a plain decimal number — the only names the
store ever creates — that is not a live ``personas.id`` are orphans. The one
other directory the store creates, ``.incoming`` (a persona bundle staged by an
import before its persona exists, #248), is the import's own to clear and is
not listed. Anything else under the root is listed as unrecognised and never
touched, whatever the flag. ``--apply`` refuses to run against a database with no personas at all
unless ``--allow-empty-database`` says that is intended: a fresh or
not-yet-restored database would make every directory look orphaned, which is
the failure this script exists to avoid. The exit status is non-zero when
anything that should have gone is still there.
"""

from __future__ import annotations

import argparse
import logging
import shutil
import sys
from dataclasses import dataclass, field
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
    """What one pass over the root found, and — after ``--apply`` — what it could not remove."""

    orphans: list[tuple[Path, int]]  # directory, bytes it holds
    unrecognised: list[Path]
    left_behind: list[Path] = field(default_factory=list)


def is_persona_id(name: str) -> bool:
    """Only the names ``persona_dir`` can produce: ASCII decimal, no sign, no leading zero.

    ``str.isdigit`` alone is true for ``²`` and ``①`` (which ``int`` refuses)
    and for ``٣`` and ``007`` (which ``int`` maps onto some other id).
    """
    return name.isascii() and name.isdigit() and str(int(name)) == name


def find_orphans(root: Path, live_ids: set[int]) -> Sweep:
    """Classify every directory directly under ``root``. Pure: reads sizes, deletes nothing."""
    orphans: list[tuple[Path, int]] = []
    unrecognised: list[Path] = []
    if not root.exists():
        return Sweep(orphans, unrecognised)
    for entry in sorted(root.iterdir()):
        if entry.name == paths.INCOMING_DIR_NAME and entry.is_dir():
            continue
        if not entry.is_dir():
            unrecognised.append(entry)
            continue
        if not is_persona_id(entry.name):
            unrecognised.append(entry)
            continue
        if int(entry.name) in live_ids:
            continue
        orphans.append((entry, directory_bytes(entry)))
    return Sweep(orphans, unrecognised)


def sweep(root: Path, live_ids: set[int], apply: bool, out=sys.stdout) -> Sweep:
    """Print the classification; remove the orphans only when ``apply`` is set.

    Reports what actually happened: ``rmtree`` swallows its errors, so each
    directory is checked afterwards and the ones still there are listed as
    ``could not remove`` and counted in ``left_behind`` rather than in the
    total.
    """
    found = find_orphans(root, live_ids)
    print(f"{len(live_ids)} live persona ids", file=out)
    verb = "removing" if apply else "would remove"
    removed: list[tuple[Path, int]] = []
    left_behind: list[Path] = []
    for directory, size in found.orphans:
        print(f"{verb} {directory}  ({size} bytes)", file=out)
        if not apply:
            continue
        shutil.rmtree(directory, ignore_errors=True)
        if directory.exists():
            left_behind.append(directory)
            print(f"could not remove {directory}", file=out)
        else:
            removed.append((directory, size))
    for entry in found.unrecognised:
        print(f"unrecognised, left alone: {entry}", file=out)
    if not found.orphans:
        print("no orphaned character asset directories", file=out)
    elif apply:
        total = sum(size for _, size in removed)
        line = f"removed {len(removed)} directories, {total} bytes"
        if left_behind:
            line += f"; {len(left_behind)} could not be removed"
        print(line, file=out)
    else:
        total = sum(size for _, size in found.orphans)
        print(f"{len(found.orphans)} directories, {total} bytes — run again with --apply to remove them", file=out)
    return Sweep(found.orphans, found.unrecognised, left_behind)


def live_persona_ids() -> set[int]:
    """Every ``personas.id`` in the configured database."""
    from sqlalchemy import select

    from kurisuassistant.db.models import Persona
    from kurisuassistant.db.session import get_session

    with get_session() as session:
        return {row[0] for row in session.execute(select(Persona.id))}


def main(argv: list[str] | None = None, out=sys.stdout) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--apply", action="store_true", help="remove the orphans instead of listing them")
    parser.add_argument(
        "--allow-empty-database",
        action="store_true",
        help="let --apply run even though the database has no personas (every directory is then an orphan)",
    )
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    live_ids = live_persona_ids()
    if args.apply and not live_ids and not args.allow_empty_database:
        print(
            "refusing --apply: the database has no personas, so every directory under "
            f"{paths.CHAR_ASSETS_DIR} would be removed. If this database is really empty "
            "(not fresh, not waiting for a restore), run again with --allow-empty-database.",
            file=out,
        )
        return 2
    found = sweep(paths.CHAR_ASSETS_DIR, live_ids, apply=args.apply, out=out)
    return 1 if found.left_behind else 0


if __name__ == "__main__":
    sys.exit(main())
