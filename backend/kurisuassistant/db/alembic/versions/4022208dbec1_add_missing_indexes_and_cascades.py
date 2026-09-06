"""add_missing_indexes_and_cascades

Every foreign key a hot read filters on gets an index, the user-owned ones get
the ``ondelete`` their ORM relationships already assume, and the messages index
becomes composite so it covers the sort as well as the filter (#95).

It also repairs one thing that is not a schema change at all. The vector index
over face embeddings is created by 20486507cf9d, but it was never declared on
the model, so `alembic revision --autogenerate` proposed dropping it every time
and one long-running deployment ended up without an index its own migration
history says it has (#162). The model declares it now, and the CREATE below is
idempotent: a no-op on a database that has it, a repair on the one that does
not.

Revision ID: 4022208dbec1
Revises: c2d999801f26
Create Date: 2026-09-06 09:22:43.547580

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '4022208dbec1'
down_revision: Union[str, Sequence[str], None] = 'c2d999801f26'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Foreign keys a read filters on, and the cascade the ORM already assumes.
    op.create_index(op.f('ix_conversations_user_id'), 'conversations', ['user_id'], unique=False)
    op.drop_constraint('conversations_user_id_fkey', 'conversations', type_='foreignkey')
    op.create_foreign_key(
        'conversations_user_id_fkey', 'conversations', 'users', ['user_id'], ['id'], ondelete='CASCADE',
    )

    op.create_index(op.f('ix_face_identities_user_id'), 'face_identities', ['user_id'], unique=False)
    op.drop_constraint('face_identities_user_id_fkey', 'face_identities', type_='foreignkey')
    op.create_foreign_key(
        'face_identities_user_id_fkey', 'face_identities', 'users', ['user_id'], ['id'], ondelete='CASCADE',
    )

    op.create_index(op.f('ix_mcp_servers_user_id'), 'mcp_servers', ['user_id'], unique=False)
    op.drop_constraint('mcp_servers_user_id_fkey', 'mcp_servers', type_='foreignkey')
    op.create_foreign_key(
        'mcp_servers_user_id_fkey', 'mcp_servers', 'users', ['user_id'], ['id'], ondelete='CASCADE',
    )

    op.create_index(op.f('ix_skills_user_id'), 'skills', ['user_id'], unique=False)
    op.drop_constraint('skills_user_id_fkey', 'skills', type_='foreignkey')
    op.create_foreign_key(
        'skills_user_id_fkey', 'skills', 'users', ['user_id'], ['id'], ondelete='CASCADE',
    )

    op.create_index(op.f('ix_face_photos_identity_id'), 'face_photos', ['identity_id'], unique=False)
    op.create_index(op.f('ix_personas_user_id'), 'personas', ['user_id'], unique=False)
    op.create_index(op.f('ix_sub_agents_user_id'), 'sub_agents', ['user_id'], unique=False)

    # The composite index covers the filter and the sort together; the lone one
    # on conversation_id is redundant under it, so it goes.
    op.drop_index(op.f('ix_messages_conversation_id'), table_name='messages')
    op.create_index(
        'ix_messages_conversation_id_id', 'messages',
        ['conversation_id', sa.literal_column('id DESC')], unique=False,
    )

    # Not a change — a repair, for a database whose recorded history says it
    # already has this (#162). IF NOT EXISTS makes it a no-op everywhere else.
    op.execute(
        'CREATE INDEX IF NOT EXISTS ix_face_photos_embedding_hnsw '
        'ON face_photos USING hnsw (embedding vector_cosine_ops)'
    )


def downgrade() -> None:
    """Downgrade schema.

    The vector index is left alone: 20486507cf9d owns it, and dropping it here
    would undo more than this revision added.
    """
    op.drop_index('ix_messages_conversation_id_id', table_name='messages')
    op.create_index(op.f('ix_messages_conversation_id'), 'messages', ['conversation_id'], unique=False)

    op.drop_index(op.f('ix_sub_agents_user_id'), table_name='sub_agents')
    op.drop_index(op.f('ix_personas_user_id'), table_name='personas')
    op.drop_index(op.f('ix_face_photos_identity_id'), table_name='face_photos')

    for table in ('skills', 'mcp_servers', 'face_identities', 'conversations'):
        op.drop_constraint(f'{table}_user_id_fkey', table, type_='foreignkey')
        op.create_foreign_key(f'{table}_user_id_fkey', table, 'users', ['user_id'], ['id'])
        op.drop_index(op.f(f'ix_{table}_user_id'), table_name=table)
