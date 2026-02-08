"""Add raw_input and raw_output fields to messages

Revision ID: add_raw_io_to_messages
Revises: drop_is_main_from_agents
Create Date: 2026-02-05
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'add_raw_io_to_messages'
down_revision = 'drop_is_main_from_agents'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('messages', sa.Column('raw_input', sa.Text(), nullable=True))
    op.add_column('messages', sa.Column('raw_output', sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column('messages', 'raw_output')
    op.drop_column('messages', 'raw_input')
