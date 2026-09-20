"""Migration coverage for 3eb07d0e8d1f — stamping ``character_config`` with its ``kind``.

Every branch of that migration only does something when there is a row to
match it, so this seeds one persona per branch at the previous revision, runs
the real migration through alembic, and asserts on each row — then downgrades
and upgrades again to show what a round trip keeps.

Marked ``db``: it needs a Postgres it is allowed to create and drop databases
on, through the usual ``POSTGRES_*`` variables. It never touches the configured
application database.
"""

import json
import os
import uuid

import pytest
import sqlalchemy as sa

pytestmark = pytest.mark.db

KIND_REVISION = "3eb07d0e8d1f"
PRE_KIND_REVISION = "4281377948c4"

POSE_TREE = {"default_pose_ids": ["a1b2c3d4"], "nodes": [{"id": "a1b2c3d4", "name": "idle",
             "type": "pose", "position": {"x": 1.5, "y": 0}, "pose_config": {"name": "idle",
             "base_image_url": "/character-assets/1/a1b2c3d4/base"}}], "edges": []}
VRM = {"model": None, "clips": [], "idle": {"procedural": True}, "reactions": []}

# One persona per branch of upgrade():
#   1 pose graph, no kind        → stamped pose_graph
#   2 SQL NULL                    → untouched
#   3 the JSON literal null       → SQL NULL (what every API-created persona carried)
#   4 {}                          → SQL NULL
#   5 already kinded pose graph   → untouched
#   6 a vrm row, already kinded   → untouched, byte-identical
#   7 {"poses": …}, neither key   → left as-is, logged
#   8 not an object               → left as-is, logged
#   9 both members, no kind       → pose_graph (the rig every protocol-6 client rendered)
#  10 vrm member only, no kind    → vrm
ROWS = {
    1: {"pose_tree": POSE_TREE},
    2: None,
    3: "null",
    4: {},
    5: {"kind": "pose_graph", "pose_tree": POSE_TREE},
    6: {"kind": "vrm", "vrm": VRM},
    7: {"poses": {"idle": "/character-assets/7/idle.png"}},
    8: '"hello"',
    9: {"pose_tree": POSE_TREE, "vrm": VRM},
    10: {"vrm": VRM},
}


def _literal(value) -> str:
    if value is None:
        return "NULL"
    if value in ("null", '"hello"'):
        return f"'{value}'::json"
    return "'" + json.dumps(value).replace("'", "''") + "'::json"


FIXTURE = (
    "INSERT INTO users (id, username, password) VALUES (1, 'owner', 'x');\n"
    "INSERT INTO personas (id, user_id, name, description, system_prompt, enabled, character_config) VALUES\n"
    + ",\n".join(
        f"({pid}, 1, 'persona-{pid}', '', '', true, {_literal(cfg)})" for pid, cfg in ROWS.items()
    )
    + ";\n"
)


def _admin_url() -> str:
    user = os.getenv("POSTGRES_USER", "kurisu")
    password = os.getenv("POSTGRES_PASSWORD", "kurisu")
    host = os.getenv("POSTGRES_HOST", "localhost")
    port = os.getenv("POSTGRES_PORT", "5432")
    return f"postgresql://{user}:{password}@{host}:{port}/postgres"


def _alembic_config(db_name: str):
    from alembic.config import Config

    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    db_dir = os.path.join(here, "kurisuassistant", "db")
    config = Config(os.path.join(db_dir, "alembic.ini"))
    config.set_main_option("script_location", os.path.join(db_dir, "alembic"))
    os.environ["POSTGRES_DB"] = db_name
    return config


@pytest.fixture()
def seeded_db():
    """A throwaway database seeded at the pre-kind revision; the test drives alembic."""
    from alembic import command

    try:
        admin = sa.create_engine(_admin_url(), isolation_level="AUTOCOMMIT")
        with admin.connect() as conn:
            conn.execute(sa.text("SELECT 1"))
    except Exception as exc:  # pragma: no cover - environment dependent
        pytest.skip(f"no Postgres available for migration tests: {exc}")

    db_name = f"kurisu_mig_{uuid.uuid4().hex[:12]}"
    previous_db = os.environ.get("POSTGRES_DB")
    with admin.connect() as conn:
        conn.execute(sa.text(f'CREATE DATABASE "{db_name}"'))

    config = _alembic_config(db_name)
    url = _admin_url().rsplit("/", 1)[0] + f"/{db_name}"
    engine = sa.create_engine(url)
    try:
        command.upgrade(config, PRE_KIND_REVISION)
        with engine.begin() as conn:
            conn.execute(sa.text(FIXTURE))
        yield engine, config
    finally:
        engine.dispose()
        if previous_db is None:
            os.environ.pop("POSTGRES_DB", None)
        else:
            os.environ["POSTGRES_DB"] = previous_db
        with admin.connect() as conn:
            conn.execute(sa.text(f'DROP DATABASE IF EXISTS "{db_name}" WITH (FORCE)'))
        admin.dispose()


def _configs(engine) -> dict:
    """Every persona's column as text, so SQL NULL and JSON null stay distinguishable."""
    with engine.connect() as conn:
        rows = conn.execute(
            sa.text("SELECT id, character_config::text FROM personas ORDER BY id")
        ).fetchall()
    return {pid: (None if text is None else json.loads(text)) for pid, text in rows}


def _sql_null(engine, persona_id: int) -> bool:
    with engine.connect() as conn:
        return conn.execute(
            sa.text("SELECT character_config IS NULL FROM personas WHERE id = :id"),
            {"id": persona_id},
        ).scalar_one()


def test_the_fixture_reproduces_the_json_null_the_api_used_to_write(seeded_db):
    engine, _ = seeded_db
    assert _sql_null(engine, 2) is True
    assert _sql_null(engine, 3) is False, "row 3 must be the JSON literal, not SQL NULL"


def test_upgrade_stamps_normalises_and_leaves_alone_per_row(seeded_db):
    from alembic import command

    engine, config = seeded_db
    command.upgrade(config, KIND_REVISION)
    after = _configs(engine)

    assert after[1] == {"pose_tree": POSE_TREE, "kind": "pose_graph"}
    assert after[1]["pose_tree"] == POSE_TREE, "the tree itself is byte-identical"
    assert after[2] is None and _sql_null(engine, 2)
    assert after[3] is None and _sql_null(engine, 3), "JSON null becomes SQL NULL"
    assert after[4] is None and _sql_null(engine, 4), "{} becomes SQL NULL"
    assert after[5] == ROWS[5]
    assert after[6] == ROWS[6]
    assert after[7] == ROWS[7], "no pose tree and no kind: left as-is, not guessed"
    assert after[8] == "hello"
    assert after[9] == {**ROWS[9], "kind": "pose_graph"}
    assert after[10] == {**ROWS[10], "kind": "vrm"}


def test_downgrade_pops_kind_from_every_row_and_nothing_else(seeded_db):
    from alembic import command

    engine, config = seeded_db
    command.upgrade(config, KIND_REVISION)
    command.downgrade(config, PRE_KIND_REVISION)
    after = _configs(engine)

    assert after[1] == ROWS[1], "a pose-graph row goes back to what protocol 6 wrote"
    assert after[5] == {"pose_tree": POSE_TREE}
    assert after[6] == {"vrm": VRM}, "a vrm row keeps its member and loses the selector"
    assert after[7] == ROWS[7]
    assert after[8] == "hello"
    # The rows normalised to SQL NULL are not restored: both read back as None.
    assert after[3] is None and after[4] is None


def test_a_round_trip_is_byte_identical_for_pose_graphs_and_recovers_kind_for_vrm(seeded_db):
    from alembic import command

    engine, config = seeded_db
    command.upgrade(config, KIND_REVISION)
    once = _configs(engine)
    command.downgrade(config, PRE_KIND_REVISION)
    command.upgrade(config, KIND_REVISION)
    twice = _configs(engine)

    assert twice[1] == once[1]
    assert twice[5] == once[5]
    assert twice[6] == once[6], "the vrm-only row is recognised again from its member"
    assert twice[10] == once[10]
    # The one thing a round trip cannot keep: which of two members was selected.
    # Row 9 held both and said vrm before the downgrade; it says pose_graph after.
    with engine.begin() as conn:
        conn.execute(sa.text("UPDATE personas SET character_config = :c WHERE id = 9"),
                     {"c": json.dumps({**ROWS[9], "kind": "vrm"})})
    command.downgrade(config, PRE_KIND_REVISION)
    command.upgrade(config, KIND_REVISION)
    assert _configs(engine)[9] == {**ROWS[9], "kind": "pose_graph"}
