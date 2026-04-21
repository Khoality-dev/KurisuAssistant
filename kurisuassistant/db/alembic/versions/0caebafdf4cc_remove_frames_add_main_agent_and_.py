"""remove_frames_add_main_agent_and_trigger_word

Revision ID: 0caebafdf4cc
Revises: facf3c9e62a8
Create Date: 2026-04-21 07:18:47.780198

One-shot restructure that:
- Adds ``agents.trigger_word`` (text, nullable) — each MainAgent can
  optionally advertise a trigger word so the first message of a new
  conversation can pick them deterministically. This field existed on
  the old ``personas`` table and was lost in the persona→agent merge.
- Adds ``conversations.main_agent_id`` (int, nullable, FK → agents.id
  ON DELETE SET NULL). Nullable at rest — pick happens on first message
  when null. Existing conversations stay null and get picked on next
  message.
- Adds ``messages.conversation_id`` (int, nullable initially). Backfills
  from ``messages.frame.conversation_id``, then switches to NOT NULL and
  adds an index.
- Drops the ``frames`` table and ``messages.frame_id`` FK. Frame-based
  summarization and routing are gone — ``conversations.compacted_context``
  is now the single summary source per conversation.

Downgrade is lossy: the ``frames`` table is recreated but with empty data;
no attempt is made to re-segment historical messages.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0caebafdf4cc'
down_revision: Union[str, Sequence[str], None] = 'facf3c9e62a8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # 1. Add trigger_word to agents
    op.add_column('agents', sa.Column('trigger_word', sa.String(), nullable=True))

    # 2. Add main_agent_id to conversations (FK set null on agent delete)
    op.add_column(
        'conversations',
        sa.Column('main_agent_id', sa.Integer(), nullable=True),
    )
    op.create_foreign_key(
        'fk_conversations_main_agent_id',
        'conversations', 'agents',
        ['main_agent_id'], ['id'],
        ondelete='SET NULL',
    )

    # 3. Add messages.conversation_id, backfill from frame.conversation_id,
    #    then make NOT NULL and index.
    op.add_column(
        'messages',
        sa.Column('conversation_id', sa.Integer(), nullable=True),
    )
    op.execute("""
        UPDATE messages
        SET conversation_id = frames.conversation_id
        FROM frames
        WHERE messages.frame_id = frames.id
    """)
    # Any messages without a frame (shouldn't happen) are dropped
    op.execute("DELETE FROM messages WHERE conversation_id IS NULL")
    op.alter_column('messages', 'conversation_id', nullable=False)
    op.create_foreign_key(
        'fk_messages_conversation_id',
        'messages', 'conversations',
        ['conversation_id'], ['id'],
        ondelete='CASCADE',
    )
    op.create_index('ix_messages_conversation_id', 'messages', ['conversation_id'])

    # 4. Drop messages.frame_id FK + column and the frames table
    # The existing FK constraint name comes from the model; find it generically
    # (Alembic defaults to the column-based name when none was specified).
    with op.batch_alter_table('messages') as batch_op:
        # Drop any FK on frame_id. The name is not explicitly set in the model,
        # so postgres auto-named it. Use a raw drop_constraint via inspection.
        pass
    op.execute("""
        DO $$
        DECLARE
            fk_name text;
        BEGIN
            SELECT conname INTO fk_name
            FROM pg_constraint
            WHERE conrelid = 'messages'::regclass
              AND contype = 'f'
              AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
                                  WHERE attrelid = 'messages'::regclass
                                    AND attname = 'frame_id')]::int2[];
            IF fk_name IS NOT NULL THEN
                EXECUTE format('ALTER TABLE messages DROP CONSTRAINT %I', fk_name);
            END IF;
        END $$;
    """)
    # Drop the index on frame_id if present
    op.execute("DROP INDEX IF EXISTS ix_messages_frame_id")
    op.drop_column('messages', 'frame_id')

    # Now the frames table has no FKs pointing to it — drop it
    op.drop_table('frames')


def downgrade() -> None:
    """Downgrade schema (lossy — no frame data preserved)."""
    # Recreate frames table
    op.create_table(
        'frames',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('conversation_id', sa.Integer(), nullable=False),
        sa.Column('summary', sa.Text(), nullable=True),
        sa.Column('active_agent_id', sa.Integer(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(['conversation_id'], ['conversations.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['active_agent_id'], ['agents.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_frames_conversation_id', 'frames', ['conversation_id'])

    # Re-add messages.frame_id (nullable, no backfill — historical frames are gone)
    op.add_column('messages', sa.Column('frame_id', sa.Integer(), nullable=True))
    op.create_foreign_key(
        'fk_messages_frame_id',
        'messages', 'frames',
        ['frame_id'], ['id'],
        ondelete='CASCADE',
    )
    op.create_index('ix_messages_frame_id', 'messages', ['frame_id'])

    # Drop messages.conversation_id additions
    op.drop_index('ix_messages_conversation_id', table_name='messages')
    op.drop_constraint('fk_messages_conversation_id', 'messages', type_='foreignkey')
    op.drop_column('messages', 'conversation_id')

    # Drop conversations.main_agent_id
    op.drop_constraint('fk_conversations_main_agent_id', 'conversations', type_='foreignkey')
    op.drop_column('conversations', 'main_agent_id')

    # Drop agents.trigger_word
    op.drop_column('agents', 'trigger_word')
