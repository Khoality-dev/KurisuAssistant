"""Add character_config JSON field to agents for video call animation tree

Revision ID: d6a6c8a823e6
Revises: b6caef076791
Create Date: 2026-02-07
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'd6a6c8a823e6'
down_revision = '2cb33cb432c5'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('agents', sa.Column('character_config', sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column('agents', 'character_config')
