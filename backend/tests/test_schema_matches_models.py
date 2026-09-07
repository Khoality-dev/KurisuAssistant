"""A database at a revision must match one freshly migrated to it (#162).

A live deployment reported itself fully migrated while its schema differed from
what the migration chain produces: the vector index over face embeddings was
missing, and nothing noticed until someone diffed it against a throwaway
database by hand. The cause was upstream of that deployment — the index is
created by a migration but was never declared on the model, so every
`alembic revision --autogenerate` proposed dropping it and the models and the
migrations quietly disagreed about what the schema is.

These tests make that disagreement fail out loud, in two directions:

  * `compare_metadata` over a freshly migrated database — the models and the
    migration chain must produce the same schema, which is the check that would
    have caught the drift at the source;
  * the indexes and cascades #95 asked for actually exist after migrating.

Marked ``db``: needs a Postgres it may create and drop databases on.
"""

import os
import uuid

import pytest
import sqlalchemy as sa

pytestmark = pytest.mark.db


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


@pytest.fixture(scope="module")
def freshly_migrated():
    """A throwaway database taken to head by the real migration chain."""
    from alembic import command

    try:
        admin = sa.create_engine(_admin_url(), isolation_level="AUTOCOMMIT")
        with admin.connect() as conn:
            conn.execute(sa.text("SELECT 1"))
    except Exception as exc:  # pragma: no cover - environment dependent
        pytest.skip(f"no Postgres available: {exc}")

    db_name = f"kurisu_schema_{uuid.uuid4().hex[:12]}"
    previous_db = os.environ.get("POSTGRES_DB")
    with admin.connect() as conn:
        conn.execute(sa.text(f'CREATE DATABASE "{db_name}"'))

    config = _alembic_config(db_name)
    url = _admin_url().rsplit("/", 1)[0] + f"/{db_name}"
    engine = sa.create_engine(url)
    try:
        command.upgrade(config, "head")
        yield engine
    finally:
        engine.dispose()
        if previous_db is not None:
            os.environ["POSTGRES_DB"] = previous_db
        with admin.connect() as conn:
            conn.execute(
                sa.text(
                    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                    "WHERE datname = :db AND pid <> pg_backend_pid()"
                ),
                {"db": db_name},
            )
            conn.execute(sa.text(f'DROP DATABASE IF EXISTS "{db_name}"'))
        admin.dispose()


def _indexes(engine, table: str) -> dict:
    return {i["name"]: i for i in sa.inspect(engine).get_indexes(table)}


class TestModelsAndMigrationsAgree:
    def test_nothing_is_left_over_after_migrating_to_head(self, freshly_migrated):
        """The check the drift got past.

        `compare_metadata` is what `--autogenerate` runs. If it finds anything
        on a database the chain just built, then the next generated migration
        carries that difference — which is how a live index came to be proposed
        for deletion on every run.
        """
        from alembic.autogenerate import compare_metadata
        from alembic.migration import MigrationContext

        from kurisuassistant.db.base import Base
        import kurisuassistant.db.models  # noqa: F401 — registers the tables

        with freshly_migrated.connect() as conn:
            diff = compare_metadata(MigrationContext.configure(conn), Base.metadata)

        assert diff == [], (
            "the models and the migration chain disagree about the schema; "
            f"`alembic revision --autogenerate` would emit: {diff}"
        )


class TestTheVectorIndexExists:
    def test_face_embeddings_are_indexed(self, freshly_migrated):
        """Missing on one deployment, present on a fresh database (#162)."""
        assert "ix_face_photos_embedding_hnsw" in _indexes(freshly_migrated, "face_photos")

    def test_it_is_an_hnsw_index_over_cosine_distance(self, freshly_migrated):
        with freshly_migrated.connect() as conn:
            definition = conn.execute(
                sa.text("SELECT indexdef FROM pg_indexes WHERE indexname = :n"),
                {"n": "ix_face_photos_embedding_hnsw"},
            ).scalar_one()
        assert "USING hnsw" in definition
        assert "vector_cosine_ops" in definition


class TestTheIndexesTheHotReadsNeed:
    def test_messages_are_indexed_for_the_filter_and_the_sort(self, freshly_migrated):
        """A lone index on conversation_id does not cover the ORDER BY (#95)."""
        indexes = _indexes(freshly_migrated, "messages")
        assert "ix_messages_conversation_id_id" in indexes
        composite = indexes["ix_messages_conversation_id_id"]
        assert composite["column_names"][0] == "conversation_id"
        assert len(composite["column_names"]) == 2 or composite.get("expressions")
        assert "ix_messages_conversation_id" not in indexes, (
            "the single-column index is redundant under the composite one"
        )

    @pytest.mark.parametrize(
        "table,index",
        [
            ("conversations", "ix_conversations_user_id"),
            ("personas", "ix_personas_user_id"),
            ("sub_agents", "ix_sub_agents_user_id"),
            ("skills", "ix_skills_user_id"),
            ("mcp_servers", "ix_mcp_servers_user_id"),
            ("face_identities", "ix_face_identities_user_id"),
            ("face_photos", "ix_face_photos_identity_id"),
            ("drive_nodes", "ix_drive_nodes_user_id"),
            ("drive_nodes", "ix_drive_nodes_parent_id"),
            ("passages", "ix_passages_user_id"),
            ("passages", "ix_passages_conversation_id"),
            ("passages", "ix_passages_message_id"),
            ("passages", "ix_passages_drive_node_id"),
            ("passages", "ix_passages_user_id_embedding_model"),
        ],
    )
    def test_every_hot_foreign_key_is_indexed(self, freshly_migrated, table, index):
        assert index in _indexes(freshly_migrated, table)

    def test_the_embedding_backlog_index_is_partial(self, freshly_migrated):
        """The scan for passages still to embed runs every minute; a partial
        index over exactly that predicate stays small once the backlog is
        drained, where a full one would cover the table (#6)."""
        with freshly_migrated.connect() as conn:
            definition = conn.execute(
                sa.text("SELECT indexdef FROM pg_indexes WHERE indexname = :n"),
                {"n": "ix_passages_pending_embed"},
            ).scalar_one()
        assert "WHERE" in definition
        assert "embedding IS NULL" in definition
        assert "embed_attempts < 5" in definition

    def test_passage_embeddings_have_no_fixed_dimension(self, freshly_migrated):
        """The model is the operator's choice, so the column cannot commit to a
        width — which also means no HNSW index, by pgvector's rules (#6)."""
        with freshly_migrated.connect() as conn:
            declared = conn.execute(
                sa.text(
                    "SELECT format_type(atttypid, atttypmod) FROM pg_attribute "
                    "WHERE attrelid = 'passages'::regclass AND attname = 'embedding'"
                ),
            ).scalar_one()
        assert declared == "vector"


class TestCascadesReachTheDatabase:
    @pytest.mark.parametrize(
        "table", ["conversations", "personas", "sub_agents", "skills", "mcp_servers",
                  "face_identities", "drive_nodes", "passages"],
    )
    def test_user_owned_rows_go_with_their_user(self, freshly_migrated, table):
        """The ORM declared these cascades; the database did not enforce them,
        so any delete that did not go through a loaded relationship left
        orphans (#95)."""
        with freshly_migrated.connect() as conn:
            rule = conn.execute(
                sa.text(
                    "SELECT rc.delete_rule FROM information_schema.referential_constraints rc "
                    "JOIN information_schema.table_constraints tc "
                    "  ON tc.constraint_name = rc.constraint_name "
                    "WHERE tc.table_name = :t AND tc.constraint_name = :c"
                ),
                {"t": table, "c": f"{table}_user_id_fkey"},
            ).scalar_one()
        assert rule == "CASCADE"

    def test_deleting_a_user_takes_their_conversations(self, freshly_migrated):
        """The property itself, not just the catalogue entry."""
        with freshly_migrated.begin() as conn:
            conn.execute(sa.text(
                "INSERT INTO users (id, username, password) VALUES (9001, 'cascade-probe', 'x')"
            ))
            conn.execute(sa.text(
                "INSERT INTO conversations (id, user_id, title) VALUES (9001, 9001, 'probe')"
            ))
            conn.execute(sa.text("DELETE FROM users WHERE id = 9001"))
            left = conn.execute(
                sa.text("SELECT count(*) FROM conversations WHERE id = 9001")
            ).scalar_one()
        assert left == 0

    @pytest.mark.parametrize(
        "column,parent",
        [("message_id", "messages"), ("conversation_id", "conversations"), ("drive_node_id", "drive_nodes")],
    )
    def test_a_passage_goes_with_its_source(self, freshly_migrated, column, parent):
        """The message and drive deletes are bulk statements that fire no ORM
        events, so the database has to be what removes a passage whose source
        is gone (#6)."""
        with freshly_migrated.connect() as conn:
            rule = conn.execute(
                sa.text(
                    "SELECT rc.delete_rule FROM information_schema.referential_constraints rc "
                    "JOIN information_schema.table_constraints tc "
                    "  ON tc.constraint_name = rc.constraint_name "
                    "WHERE tc.table_name = 'passages' AND tc.constraint_name = :c"
                ),
                {"c": f"passages_{column}_fkey"},
            ).scalar_one()
        assert rule == "CASCADE", f"passages.{column} -> {parent}"
