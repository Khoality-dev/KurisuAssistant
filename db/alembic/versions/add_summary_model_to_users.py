"""Add summary_model column to users table

Revision ID: add_summary_model_to_users
Revises: add_summary_to_frames
Create Date: 2026-02-14
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'add_summary_model_to_users'
down_revision = 'add_summary_to_frames'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('users', sa.Column('summary_model', sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column('users', 'summary_model')
