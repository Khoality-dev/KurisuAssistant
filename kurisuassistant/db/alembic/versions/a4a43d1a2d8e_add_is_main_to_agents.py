"""Add is_main field to agents

Revision ID: a4a43d1a2d8e
Revises: 410cec9525dc
Create Date: 2025-02-04
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'a4a43d1a2d8e'
down_revision = '410cec9525dc'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('agents', sa.Column('is_main', sa.Boolean(), nullable=False, server_default='false'))


def downgrade() -> None:
    op.drop_column('agents', 'is_main')
