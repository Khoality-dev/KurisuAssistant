"""Add summary column to frames table

Revision ID: 4399446d0d1e
Revises: 20486507cf9d
Create Date: 2026-02-14
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '4399446d0d1e'
down_revision = '20486507cf9d'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('frames', sa.Column('summary', sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column('frames', 'summary')
