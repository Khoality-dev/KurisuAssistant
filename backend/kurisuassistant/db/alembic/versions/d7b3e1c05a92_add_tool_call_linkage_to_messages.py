"""Add tool-call linkage to messages

Revision ID: d7b3e1c05a92
Revises: c4f1a9e7d2b3
Create Date: 2026-09-04 08:20:00.000000

Within a single turn the agent loop builds correct tool-call structure: the
assistant message carries ``tool_calls`` and each result is a ``tool`` message
answering one of them. None of that survived persistence, because there was
nowhere to put it.

On the next turn the model was therefore shown ``tool`` messages with no
preceding assistant call and no id linking them. Ollama tolerates that shape,
which is why it went unnoticed; OpenAI-compatible endpoints such as the NVIDIA
provider reject it outright, so any conversation that used a tool would fail on
the following turn once the agent's provider was switched.

Both columns are nullable with no backfill. Messages written before this point
have no linkage to recover — the ids were never generated — and the prompt
builder simply omits what is absent, which leaves those old turns exactly as
they behave today.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'd7b3e1c05a92'
down_revision: Union[str, Sequence[str], None] = 'c4f1a9e7d2b3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add messages.tool_calls and messages.tool_call_id."""
    op.add_column('messages', sa.Column('tool_calls', sa.JSON(), nullable=True))
    op.add_column('messages', sa.Column('tool_call_id', sa.String(), nullable=True))


def downgrade() -> None:
    """Drop the linkage columns."""
    op.drop_column('messages', 'tool_call_id')
    op.drop_column('messages', 'tool_calls')
