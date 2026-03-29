"""rename_excluded_tools_to_available_tools

Revision ID: 984ab5611ea6
Revises: 094c553fc149
Create Date: 2026-03-29 21:43:40.723793

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '984ab5611ea6'
down_revision: Union[str, Sequence[str], None] = '094c553fc149'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.alter_column('agents', 'excluded_tools', new_column_name='available_tools')
    # Old data was a blocklist — can't reliably invert without knowing all tools.
    # Reset to null (= all tools available) so no agent loses access.
    op.execute(sa.text("UPDATE agents SET available_tools = NULL"))


def downgrade() -> None:
    """Downgrade schema."""
    op.execute(sa.text("UPDATE agents SET available_tools = NULL"))
    op.alter_column('agents', 'available_tools', new_column_name='excluded_tools')
