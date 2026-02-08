"""Add agent_id field to messages

Revision ID: add_agent_id_to_messages
Revises: add_ollama_url_to_users
Create Date: 2025-02-05
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'add_agent_id_to_messages'
down_revision = 'add_ollama_url_to_users'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('messages', sa.Column('agent_id', sa.Integer(), nullable=True))
    op.create_foreign_key(
        'fk_messages_agent_id',
        'messages',
        'agents',
        ['agent_id'],
        ['id'],
        ondelete='SET NULL'
    )


def downgrade() -> None:
    op.drop_constraint('fk_messages_agent_id', 'messages', type_='foreignkey')
    op.drop_column('messages', 'agent_id')
