"""Add agents table

Revision ID: add_agents_table
Revises: 7dd75b21ce44
Create Date: 2025-02-04
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'add_agents_table'
down_revision = '7dd75b21ce44'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'agents',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('username', sa.String(), nullable=False),
        sa.Column('name', sa.String(), nullable=False),
        sa.Column('system_prompt', sa.Text(), nullable=True),
        sa.Column('voice_reference', sa.String(), nullable=True),
        sa.Column('avatar_uuid', sa.String(), nullable=True),
        sa.Column('model_name', sa.String(), nullable=True),
        sa.Column('tools', sa.JSON(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(['username'], ['users.username'], ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('username', 'name', name='uq_agent_username_name')
    )


def downgrade() -> None:
    op.drop_table('agents')
