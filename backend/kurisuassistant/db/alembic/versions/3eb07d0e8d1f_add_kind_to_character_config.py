"""add_kind_to_character_config

Every ``personas.character_config`` says which character system it uses: a
required ``kind`` — ``pose_graph`` for the 2D rig every existing config is, or
``vrm`` for the 3D model that #224 adds. Wire protocol 7 makes ``kind`` required
on every write, so the rows have to carry it before that backend answers a
request; the clients read it and never guess (#235).

Data only, no schema change: the column stays ``JSON``. The one type change that
went with this — ``JSON(none_as_null=True)`` on the model, so a Python ``None``
lands as SQL ``NULL`` from now on — is invisible to the schema. Its history is
the reason for the first branch below: with the old default every persona
created through the API had the JSON literal ``null`` in the column, which
``IS NOT NULL`` selects and psycopg2 hands back as ``None``.

Per row:

* JSON ``null``            → SQL ``NULL``, silently (that is what it meant).
* not an object            → left alone, logged as a WARNING.
* has ``kind`` already     → left alone.
* has ``pose_tree``        → ``kind: "pose_graph"`` added; ``pose_tree`` untouched.
                             (Also when a ``vrm`` member sits beside it: the 2D rig
                             is the one every protocol-6 client could render.)
* has ``vrm`` only         → ``kind: "vrm"``. Nothing on protocol 6 wrote this; it
                             is what a downgrade leaves behind, see below.
* ``{}``                   → SQL ``NULL`` (seen in the wild; renders nothing anywhere).
* anything else            → left alone, logged as a WARNING. It has no pose tree
                             and no kind, no client has ever rendered it, and
                             nulling it would be guessing; every write path
                             refuses it until somebody saves a real config.

No disk work, as ever for this column (see 0dacee9f63b8).

``downgrade`` pops ``kind`` from every row that has one — a pose-graph row goes
back byte-identical to what a protocol-6 backend wrote, and a ``vrm`` row loses
the one key that backend would not have understood anyway; it keeps its ``vrm``
member, which that backend never reads, and its ``pose_tree`` if it has one.
A row whose only key was ``kind`` (``{"kind": "vrm"}`` is what a first save
with no members stores) becomes SQL ``NULL`` rather than ``{}``: it selected
nothing, and ``{}`` is what the next upgrade would null anyway. There is no
older backend that reads ``kind``, so there is nothing to keep it for. Upgrading
again recovers the selector from the members — except for a row that holds
both, which comes back as ``pose_graph`` whichever it said before, and the
kind-only row, which stays ``NULL``. The rows normalised from JSON ``null`` to
SQL ``NULL`` are not restored: both read back as ``None``.

Revision ID: 3eb07d0e8d1f
Revises: 4281377948c4
Create Date: 2026-09-20 11:11:25.746887

"""
import json
import logging
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# alembic.ini keeps this logger at INFO and the root at WARNING; a migration's own
# module logger inherits the root and its lines would never reach the console.
# The two data migrations before this one (0dacee9f63b8, facf3c9e62a8) do the same.
logger = logging.getLogger("alembic.runtime.migration")

# revision identifiers, used by Alembic.
revision: str = '3eb07d0e8d1f'
down_revision: Union[str, Sequence[str], None] = '4281377948c4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _rows(conn):
    return conn.execute(
        sa.text("SELECT id, character_config FROM personas WHERE character_config IS NOT NULL")
    ).fetchall()


def _write(conn, persona_id: int, config) -> None:
    if config is None:
        conn.execute(
            sa.text("UPDATE personas SET character_config = NULL WHERE id = :id"),
            {"id": persona_id},
        )
    else:
        conn.execute(
            sa.text("UPDATE personas SET character_config = :config WHERE id = :id"),
            {"config": json.dumps(config), "id": persona_id},
        )


def upgrade() -> None:
    """Stamp every pose-tree config with its kind; normalise the empty ones to NULL."""
    conn = op.get_bind()
    for persona_id, config in _rows(conn):
        if config is None:
            _write(conn, persona_id, None)
        elif not isinstance(config, dict):
            logger.warning("persona %d: character_config is not an object; left as-is", persona_id)
        elif "kind" in config:
            continue
        elif "pose_tree" in config:
            _write(conn, persona_id, {**config, "kind": "pose_graph"})
        elif "vrm" in config:
            _write(conn, persona_id, {**config, "kind": "vrm"})
        elif config == {}:
            _write(conn, persona_id, None)
        else:
            logger.warning(
                "persona %d: character_config has no pose_tree and no kind; left as-is "
                "(keys: %s)",
                persona_id,
                sorted(config),
            )


def downgrade() -> None:
    """Remove `kind` from every row that has one; everything else is left as it is.

    A row that held nothing but ``kind`` is written as SQL ``NULL``, not ``{}``.
    """
    conn = op.get_bind()
    for persona_id, config in _rows(conn):
        if isinstance(config, dict) and "kind" in config:
            # An explicit UPDATE per row: mutating the dict alone would change
            # nothing in the database.
            rest = {k: v for k, v in config.items() if k != "kind"}
            _write(conn, persona_id, rest or None)
