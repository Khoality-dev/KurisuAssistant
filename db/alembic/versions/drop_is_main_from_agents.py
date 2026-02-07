"""Drop is_main field from agents - Administrator handles routing now

Revision ID: drop_is_main_from_agents
Revises: add_agent_id_to_messages
Create Date: 2025-02-05
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'drop_is_main_from_agents'
down_revision = 'add_agent_id_to_messages'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_column('agents', 'is_main')


def downgrade() -> None:
    op.add_column('agents', sa.Column('is_main', sa.Boolean(), nullable=False, server_default='false'))
