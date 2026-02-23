"""Add mcp_servers table

Revision ID: add_mcp_servers_table
Revises: add_trigger_word_to_agents
Create Date: 2026-02-22
"""
import json
import os
from alembic import op
import sqlalchemy as sa

revision = 'add_mcp_servers_table'
down_revision = 'add_trigger_word_to_agents'
branch_labels = None
depends_on = None

MCP_CONFIG_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "mcp_config.json",
)


def upgrade() -> None:
    op.create_table(
        'mcp_servers',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('user_id', sa.Integer(), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('name', sa.String(), nullable=False),
        sa.Column('transport_type', sa.String(), nullable=False),
        sa.Column('url', sa.String(), nullable=True),
        sa.Column('command', sa.String(), nullable=True),
        sa.Column('args', sa.JSON(), nullable=True),
        sa.Column('env', sa.JSON(), nullable=True),
        sa.Column('enabled', sa.Boolean(), default=True, nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.UniqueConstraint('user_id', 'name', name='uq_mcp_server_user_id_name'),
    )

    # Migrate existing mcp_config.json entries to admin user (id=1)
    if os.path.isfile(MCP_CONFIG_PATH):
        try:
            with open(MCP_CONFIG_PATH, "r") as f:
                config = json.load(f)

            servers = config.get("mcpServers", {})
            if servers:
                mcp_table = sa.table(
                    'mcp_servers',
                    sa.column('user_id', sa.Integer),
                    sa.column('name', sa.String),
                    sa.column('transport_type', sa.String),
                    sa.column('url', sa.String),
                    sa.column('command', sa.String),
                    sa.column('args', sa.JSON),
                    sa.column('env', sa.JSON),
                    sa.column('enabled', sa.Boolean),
                )
                for name, cfg in servers.items():
                    has_url = bool(cfg.get("url"))
                    op.bulk_insert(mcp_table, [{
                        'user_id': 1,
                        'name': name,
                        'transport_type': 'sse' if has_url else 'stdio',
                        'url': cfg.get('url'),
                        'command': cfg.get('command'),
                        'args': cfg.get('args'),
                        'env': cfg.get('env'),
                        'enabled': True,
                    }])
        except Exception:
            pass  # Non-critical: skip migration if config is unreadable


def downgrade() -> None:
    op.drop_table('mcp_servers')
