"""Add character_config JSON field to agents for video call animation tree

Revision ID: add_character_config_to_agents
Revises: add_think_to_agents
Create Date: 2026-02-07
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'add_character_config_to_agents'
down_revision = 'add_name_to_messages'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('agents', sa.Column('character_config', sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column('agents', 'character_config')
