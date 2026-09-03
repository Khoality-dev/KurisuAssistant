"""Drop is_main field from kurisuassistant.agents - Administrator handles routing now

Revision ID: fdd8389c86f3
Revises: 3a0380b43210
Create Date: 2025-02-05
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'fdd8389c86f3'
down_revision = '3a0380b43210'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_column('agents', 'is_main')


def downgrade() -> None:
    op.add_column('agents', sa.Column('is_main', sa.Boolean(), nullable=False, server_default='false'))
