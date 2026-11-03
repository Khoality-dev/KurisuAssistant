"""Add agent_id field to messages

Revision ID: 3a0380b43210
Revises: 5f318b1666fa
Create Date: 2025-02-05
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '3a0380b43210'
down_revision = '5f318b1666fa'
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
