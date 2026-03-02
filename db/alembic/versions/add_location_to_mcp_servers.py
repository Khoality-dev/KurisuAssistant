"""Add location column to mcp_servers

Revision ID: add_location_to_mcp_servers
Revises: ea77116bd1c6
Create Date: 2026-03-01
"""
from alembic import op
import sqlalchemy as sa

revision = 'add_location_to_mcp_servers'
down_revision = 'ea77116bd1c6'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('mcp_servers', sa.Column('location', sa.String(), nullable=False, server_default='server'))


def downgrade() -> None:
    op.drop_column('mcp_servers', 'location')
