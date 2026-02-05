"""Refactor: User ID as PK, rename chunks to frames

This migration:
1. Adds numeric `id` column to users table as new primary key
2. Changes foreign keys in conversations/agents to use user_id
3. Removes denormalized username from messages table
4. Renames chunks table to frames
5. Renames messages.chunk_id to messages.frame_id

Revision ID: refactor_user_id_frames
Revises: add_is_main_to_agents
Create Date: 2025-02-04
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'refactor_user_id_frames'
down_revision = 'add_is_main_to_agents'
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Upgrade schema."""
    # Step 1: Add id column to users table
    op.add_column('users', sa.Column('id', sa.Integer(), autoincrement=True, nullable=True))

    # Step 2: Populate id values for existing users using window function (PostgreSQL)
    op.execute("""
        WITH numbered AS (
            SELECT username, ROW_NUMBER() OVER (ORDER BY username) as rn
            FROM users
        )
        UPDATE users SET id = numbered.rn
        FROM numbered
        WHERE users.username = numbered.username
    """)

    # Step 3: Make id NOT NULL
    op.alter_column('users', 'id', nullable=False)

    # Step 4: Add user_id columns to conversations and agents (nullable initially)
    op.add_column('conversations', sa.Column('user_id', sa.Integer(), nullable=True))
    op.add_column('agents', sa.Column('user_id', sa.Integer(), nullable=True))

    # Step 5: Migrate data - populate user_id from username
    op.execute("""
        UPDATE conversations
        SET user_id = users.id
        FROM users
        WHERE conversations.username = users.username
    """)
    op.execute("""
        UPDATE agents
        SET user_id = users.id
        FROM users
        WHERE agents.username = users.username
    """)

    # Step 6: Drop old foreign key constraints
    op.drop_constraint('conversations_username_fkey', 'conversations', type_='foreignkey')
    op.drop_constraint('agents_username_fkey', 'agents', type_='foreignkey')

    # Step 7: Make user_id NOT NULL
    op.alter_column('conversations', 'user_id', nullable=False)
    op.alter_column('agents', 'user_id', nullable=False)

    # Step 8: Drop old username columns from conversations and agents
    op.drop_column('conversations', 'username')
    op.drop_column('agents', 'username')

    # Step 9: Drop username column from messages (denormalized, not a FK)
    op.drop_column('messages', 'username')

    # Step 10: Change users primary key from username to id
    op.drop_constraint('users_pkey', 'users', type_='primary')
    op.create_primary_key('users_pkey', 'users', ['id'])

    # Step 11: Add unique constraint on username
    op.create_unique_constraint('uq_users_username', 'users', ['username'])

    # Step 12: Add new foreign key constraints pointing to users.id
    op.create_foreign_key('conversations_user_id_fkey', 'conversations', 'users', ['user_id'], ['id'])
    op.create_foreign_key('agents_user_id_fkey', 'agents', 'users', ['user_id'], ['id'])

    # Step 13: Drop old unique constraint on agents (username, name) and create new one (user_id, name)
    op.drop_constraint('uq_agent_username_name', 'agents', type_='unique')
    op.create_unique_constraint('uq_agent_user_id_name', 'agents', ['user_id', 'name'])

    # Step 14: Rename chunks table to frames
    op.rename_table('chunks', 'frames')

    # Step 15: Rename foreign key constraint for frames.conversation_id
    op.drop_constraint('chunks_conversation_id_fkey', 'frames', type_='foreignkey')
    op.create_foreign_key('frames_conversation_id_fkey', 'frames', 'conversations', ['conversation_id'], ['id'], ondelete='CASCADE')

    # Step 16: Rename messages.chunk_id to messages.frame_id
    op.alter_column('messages', 'chunk_id', new_column_name='frame_id')

    # Step 17: Update foreign key constraint for messages.frame_id
    op.drop_constraint('messages_chunk_id_fkey', 'messages', type_='foreignkey')
    op.create_foreign_key('messages_frame_id_fkey', 'messages', 'frames', ['frame_id'], ['id'], ondelete='CASCADE')


def downgrade() -> None:
    """Downgrade schema."""
    # Step 1: Rename messages.frame_id back to chunk_id
    op.drop_constraint('messages_frame_id_fkey', 'messages', type_='foreignkey')
    op.alter_column('messages', 'frame_id', new_column_name='chunk_id')

    # Step 2: Rename frames table back to chunks
    op.drop_constraint('frames_conversation_id_fkey', 'frames', type_='foreignkey')
    op.rename_table('frames', 'chunks')
    op.create_foreign_key('chunks_conversation_id_fkey', 'chunks', 'conversations', ['conversation_id'], ['id'], ondelete='CASCADE')
    op.create_foreign_key('messages_chunk_id_fkey', 'messages', 'chunks', ['chunk_id'], ['id'], ondelete='CASCADE')

    # Step 3: Add username column back to messages
    op.add_column('messages', sa.Column('username', sa.String(), nullable=True))
    # Note: We can't fully restore the username data as it was denormalized
    # Set a default value or join through chunks->conversations->users if needed
    op.execute("""
        UPDATE messages
        SET username = users.username
        FROM chunks, conversations, users
        WHERE messages.chunk_id = chunks.id
        AND chunks.conversation_id = conversations.id
        AND conversations.user_id = users.id
    """)
    op.alter_column('messages', 'username', nullable=False)

    # Step 4: Add username columns back to conversations and agents
    op.add_column('conversations', sa.Column('username', sa.String(), nullable=True))
    op.add_column('agents', sa.Column('username', sa.String(), nullable=True))

    # Step 5: Populate username from user_id
    op.execute("""
        UPDATE conversations
        SET username = users.username
        FROM users
        WHERE conversations.user_id = users.id
    """)
    op.execute("""
        UPDATE agents
        SET username = users.username
        FROM users
        WHERE agents.user_id = users.id
    """)

    # Step 6: Make username NOT NULL
    op.alter_column('conversations', 'username', nullable=False)
    op.alter_column('agents', 'username', nullable=False)

    # Step 7: Drop new foreign key constraints
    op.drop_constraint('conversations_user_id_fkey', 'conversations', type_='foreignkey')
    op.drop_constraint('agents_user_id_fkey', 'agents', type_='foreignkey')

    # Step 8: Drop user_id columns
    op.drop_column('conversations', 'user_id')
    op.drop_column('agents', 'user_id')

    # Step 9: Update agents unique constraint back to (username, name)
    op.drop_constraint('uq_agent_user_id_name', 'agents', type_='unique')
    op.create_unique_constraint('uq_agent_username_name', 'agents', ['username', 'name'])

    # Step 10: Change users primary key back to username
    op.drop_constraint('uq_users_username', 'users', type_='unique')
    op.drop_constraint('users_pkey', 'users', type_='primary')
    op.create_primary_key('users_pkey', 'users', ['username'])

    # Step 11: Add foreign key constraints back
    op.create_foreign_key('conversations_username_fkey', 'conversations', 'users', ['username'], ['username'])
    op.create_foreign_key('agents_username_fkey', 'agents', 'users', ['username'], ['username'])

    # Step 12: Drop id column from users
    op.drop_column('users', 'id')
