"""Disable server-side stdio MCP servers

Revision ID: c4f1a9e7d2b3
Revises: 0caebafdf4cc
Create Date: 2026-09-03 20:10:00.000000

A stdio MCP server entry names a command for the host to run. Those rows are
user-writable through ``POST /mcp-servers``, so a row with
``transport_type='stdio'`` and ``location='server'`` was arbitrary command
execution inside the API container for any account that could reach the API.

Server-side stdio is no longer supported: the API rejects it, and the
orchestrator refuses to build a client for it. This migration mutates the rows
that already exist so the old ones cannot keep running, rather than leaving the
runtime to skip them forever.

The rows are disabled rather than deleted, so a user can see what was turned off
and move it to ``location='client'`` if they still want it. Downgrade cannot
distinguish rows disabled here from rows the user disabled themselves, so it
deliberately does nothing.
"""
from typing import Sequence, Union

from alembic import op


revision: str = 'c4f1a9e7d2b3'
down_revision: Union[str, Sequence[str], None] = '0caebafdf4cc'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Disable every server-side stdio MCP server."""
    op.execute(
        """
        UPDATE mcp_servers
           SET enabled = false
        WHERE transport_type = 'stdio'
          AND (location = 'server' OR location IS NULL)
        """
    )


def downgrade() -> None:
    """No-op.

    Re-enabling would also re-enable rows the user had disabled for their own
    reasons, and would restore the command-execution path this migration exists
    to close.
    """
    pass
