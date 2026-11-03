"""merge heads

Revision ID: 902de88d379e
Revises: e7da982a1373, add_summary_model_to_users
Create Date: 2026-02-14 23:57:15.968521

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '902de88d379e'
down_revision: Union[str, Sequence[str], None] = ('e7da982a1373', '3e800ed76685')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
