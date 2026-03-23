"""Rename agents.tools to agents.excluded_tools

Inverts agent tool access from whitelist to exclusion list.
All existing values reset to null (no exclusions = all tools available).

Revision ID: a59cc3e208be
Revises: 15994df5a1d7, add_skills_table, add_summary_model_to_users, add_think_to_agents
Create Date: 2026-02-26
"""
from alembic import op


revision = 'a59cc3e208be'
down_revision = ('15994df5a1d7', 'e7da982a1373', '3e800ed76685', 'b6caef076791')
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Reset all existing tool whitelists to null (no exclusions = all tools available)
    op.execute("UPDATE agents SET tools = NULL")
    # Rename column
    op.alter_column('agents', 'tools', new_column_name='excluded_tools')


def downgrade() -> None:
    op.alter_column('agents', 'excluded_tools', new_column_name='tools')
