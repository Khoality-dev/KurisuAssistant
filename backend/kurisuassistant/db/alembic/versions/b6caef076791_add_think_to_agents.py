"""Add think field to agents

Revision ID: b6caef076791
Revises: cd9b004d0fd6
Create Date: 2026-02-05
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'b6caef076791'
down_revision = 'cd9b004d0fd6'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('agents', sa.Column('think', sa.Boolean(), nullable=False, server_default='false'))


def downgrade() -> None:
    op.drop_column('agents', 'think')
