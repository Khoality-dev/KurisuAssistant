"""Add is_main field to agents

Revision ID: add_is_main_to_agents
Revises: add_agents_table
Create Date: 2025-02-04
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'add_is_main_to_agents'
down_revision = 'add_agents_table'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('agents', sa.Column('is_main', sa.Boolean(), nullable=False, server_default='false'))


def downgrade() -> None:
    op.drop_column('agents', 'is_main')
