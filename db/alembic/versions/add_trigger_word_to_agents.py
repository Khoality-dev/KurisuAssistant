"""Add trigger_word column to agents

Revision ID: add_trigger_word_to_agents
Revises: migrate_character_asset_ids
Create Date: 2026-02-16
"""
from alembic import op
import sqlalchemy as sa

revision = 'add_trigger_word_to_agents'
down_revision = 'migrate_character_asset_ids'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('agents', sa.Column('trigger_word', sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column('agents', 'trigger_word')
