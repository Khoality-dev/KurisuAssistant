"""Add think field to agents

Revision ID: add_think_to_agents
Revises: add_raw_io_to_messages
Create Date: 2026-02-05
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'add_think_to_agents'
down_revision = 'add_raw_io_to_messages'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('agents', sa.Column('think', sa.Boolean(), nullable=False, server_default='false'))


def downgrade() -> None:
    op.drop_column('agents', 'think')
