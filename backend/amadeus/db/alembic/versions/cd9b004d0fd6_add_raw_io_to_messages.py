"""Add raw_input and raw_output fields to messages

Revision ID: cd9b004d0fd6
Revises: fdd8389c86f3
Create Date: 2026-02-05
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'cd9b004d0fd6'
down_revision = 'fdd8389c86f3'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('messages', sa.Column('raw_input', sa.Text(), nullable=True))
    op.add_column('messages', sa.Column('raw_output', sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column('messages', 'raw_output')
    op.drop_column('messages', 'raw_input')
