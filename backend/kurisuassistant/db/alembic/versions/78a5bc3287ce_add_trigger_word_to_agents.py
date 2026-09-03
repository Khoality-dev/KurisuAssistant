"""Add trigger_word column to agents

Revision ID: 78a5bc3287ce
Revises: 793cf16447ca
Create Date: 2026-02-16
"""
from alembic import op
import sqlalchemy as sa

revision = '78a5bc3287ce'
down_revision = '793cf16447ca'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('agents', sa.Column('trigger_word', sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column('agents', 'trigger_word')
