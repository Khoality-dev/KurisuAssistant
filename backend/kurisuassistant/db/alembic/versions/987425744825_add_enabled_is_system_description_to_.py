"""add_enabled_is_system_description_to_agents

Revision ID: 987425744825
Revises: 7a8f9c7cf0af
Create Date: 2026-03-25 22:46:00.000364

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '987425744825'
down_revision: Union[str, Sequence[str], None] = '7a8f9c7cf0af'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Agent columns: description, enabled, is_system
    op.add_column('agents', sa.Column('description', sa.String(), server_default='', nullable=False))
    op.add_column('agents', sa.Column('enabled', sa.Boolean(), server_default=sa.text('true'), nullable=False))
    op.add_column('agents', sa.Column('is_system', sa.Boolean(), server_default=sa.text('false'), nullable=False))
    op.alter_column('agents', 'user_id',
               existing_type=sa.INTEGER(),
               nullable=True)

    # Seed system agents (Administrator and App Guide)
    agents = sa.table('agents',
        sa.column('id', sa.Integer),
        sa.column('user_id', sa.Integer),
        sa.column('name', sa.String),
        sa.column('description', sa.String),
        sa.column('system_prompt', sa.Text),
        sa.column('model_name', sa.String),
        sa.column('provider_type', sa.String),
        sa.column('enabled', sa.Boolean),
        sa.column('is_system', sa.Boolean),
        sa.column('think', sa.Boolean),
        sa.column('memory_enabled', sa.Boolean),
    )

    op.bulk_insert(agents, [
        {
            'user_id': None,
            'name': 'Administrator',
            'description': 'Routes conversations to the right agent based on the request',
            'system_prompt': (
                'You are the Administrator agent. Your role is to understand what the user needs '
                'and route the conversation to the most appropriate agent using the route_to tool.\n\n'
                'When you receive a message:\n'
                '1. Analyze what the user is asking for\n'
                '2. Check which agents are available (listed in route_to tool description)\n'
                '3. Use route_to to delegate to the best agent, passing a clear summary of the task\n'
                '4. If no agent is suitable, respond directly to the user\n\n'
                'Keep your own responses brief. Your main job is delegation, not conversation.'
            ),
            'model_name': 'qwen3.5:0.8b',
            'provider_type': 'ollama',
            'enabled': True,
            'is_system': True,
            'think': False,
            'memory_enabled': False,
        },
        {
            'user_id': None,
            'name': 'App Guide',
            'description': 'Helps manage app settings: agents, personas, MCP servers, skills, and vision',
            'system_prompt': (
                'You are the App Guide for KurisuAssistant. You help users manage and configure the application.\n\n'
                'You can help with:\n'
                '- Creating, editing, and managing agents and their settings\n'
                '- Managing personas (voice, avatar, character animation)\n'
                '- Configuring MCP servers for tool integrations\n'
                '- Managing skills (custom instruction blocks)\n'
                '- Vision and camera settings\n'
                '- Browser automation setup\n\n'
                'Use the available app management tools to perform actions. '
                'Be friendly and guide users step by step. '
                'When making changes, confirm what you did and suggest next steps.'
            ),
            'model_name': 'qwen3.5:0.8b',
            'provider_type': 'ollama',
            'enabled': True,
            'is_system': True,
            'think': False,
            'memory_enabled': False,
        },
    ])


def downgrade() -> None:
    """Downgrade schema."""
    # Remove seeded system agents
    op.execute("DELETE FROM agents WHERE is_system = true")

    op.alter_column('agents', 'user_id',
               existing_type=sa.INTEGER(),
               nullable=False)
    op.drop_column('agents', 'is_system')
    op.drop_column('agents', 'enabled')
    op.drop_column('agents', 'description')
