import json
import os
import logging

logger = logging.getLogger(__name__)

CONFIG_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "mcp_config.json")


def load_mcp_configs():
    """Load MCP server configuration from mcp_config.json."""
    if not os.path.isfile(CONFIG_PATH):
        return {"mcpServers": {}}

    try:
        with open(CONFIG_PATH, "r") as f:
            return json.load(f)
    except (json.JSONDecodeError, FileNotFoundError) as e:
        logger.warning(f"Could not load MCP config: {e}")
        return {"mcpServers": {}}
