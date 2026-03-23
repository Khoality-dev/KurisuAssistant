"""Add summary_model column to users table

Revision ID: 3e800ed76685
Revises: 4399446d0d1e
Create Date: 2026-02-14
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '3e800ed76685'
down_revision = '4399446d0d1e'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('users', sa.Column('summary_model', sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column('users', 'summary_model')
