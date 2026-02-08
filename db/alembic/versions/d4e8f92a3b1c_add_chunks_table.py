"""Add chunks table and migrate messages

Revision ID: d4e8f92a3b1c
Revises: 3a040bb577f9
Create Date: 2025-12-13 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import text


# revision identifiers, used by Alembic.
revision: str = 'd4e8f92a3b1c'
down_revision: Union[str, Sequence[str], None] = '3a040bb577f9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema - add chunks table and migrate messages."""
    # Step 1: Create chunks table
    op.create_table(
        'chunks',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('conversation_id', sa.Integer(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(['conversation_id'], ['conversations.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index('idx_chunks_conversation_id', 'chunks', ['conversation_id'])

    # Step 2: Add chunk_id column to messages (nullable initially)
    op.add_column('messages', sa.Column('chunk_id', sa.Integer(), nullable=True))

    # Step 3: Data migration - create one chunk per conversation and migrate messages
    connection = op.get_bind()

    # Get all conversations
    conversations = connection.execute(text("SELECT id FROM conversations ORDER BY id")).fetchall()

    for (conv_id,) in conversations:
        # Get min and max timestamps for messages in this conversation
        result = connection.execute(text("""
            SELECT MIN(created_at), MAX(updated_at)
            FROM messages
            WHERE conversation_id = :conv_id
        """), {"conv_id": conv_id}).fetchone()

        min_created = result[0] if result and result[0] else None
        max_updated = result[1] if result and result[1] else None

        # Create one chunk for this conversation
        # Use conversation timestamps if no messages exist
        if min_created is None:
            conv_result = connection.execute(text("""
                SELECT created_at, updated_at
                FROM conversations
                WHERE id = :conv_id
            """), {"conv_id": conv_id}).fetchone()
            min_created = conv_result[0] if conv_result else None
            max_updated = conv_result[1] if conv_result else None

        # Insert chunk
        chunk_result = connection.execute(text("""
            INSERT INTO chunks (conversation_id, created_at, updated_at)
            VALUES (:conv_id, :created_at, :updated_at)
            RETURNING id
        """), {
            "conv_id": conv_id,
            "created_at": min_created,
            "updated_at": max_updated
        })
        chunk_id = chunk_result.fetchone()[0]

        # Update all messages in this conversation to point to the new chunk
        connection.execute(text("""
            UPDATE messages
            SET chunk_id = :chunk_id
            WHERE conversation_id = :conv_id
        """), {"chunk_id": chunk_id, "conv_id": conv_id})

    # Step 4: Make chunk_id NOT NULL after migration
    op.alter_column('messages', 'chunk_id', nullable=False)

    # Step 5: Add foreign key constraint for chunk_id
    op.create_foreign_key(
        'fk_messages_chunk_id',
        'messages',
        'chunks',
        ['chunk_id'],
        ['id'],
        ondelete='CASCADE'
    )

    # Step 6: Create index for chunk_id
    op.create_index('idx_messages_chunk_id', 'messages', ['chunk_id'])

    # Step 7: Drop old conversation_id column and foreign key from messages
    op.drop_constraint('messages_conversation_id_fkey', 'messages', type_='foreignkey')
    op.drop_column('messages', 'conversation_id')


def downgrade() -> None:
    """Reverse the migration - restore conversation_id to messages."""
    # Add conversation_id back to messages
    op.add_column('messages', sa.Column('conversation_id', sa.Integer(), nullable=True))

    # Migrate data back: get conversation_id from chunk
    connection = op.get_bind()
    connection.execute(text("""
        UPDATE messages
        SET conversation_id = chunks.conversation_id
        FROM chunks
        WHERE messages.chunk_id = chunks.id
    """))

    # Make conversation_id NOT NULL
    op.alter_column('messages', 'conversation_id', nullable=False)

    # Re-add foreign key
    op.create_foreign_key(
        'messages_conversation_id_fkey',
        'messages',
        'conversations',
        ['conversation_id'],
        ['id']
    )

    # Drop chunk-related columns and constraints
    op.drop_constraint('fk_messages_chunk_id', 'messages', type_='foreignkey')
    op.drop_index('idx_messages_chunk_id', 'messages')
    op.drop_column('messages', 'chunk_id')

    # Drop chunks table
    op.drop_index('idx_chunks_conversation_id', 'chunks')
    op.drop_table('chunks')
