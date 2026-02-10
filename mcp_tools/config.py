import json
import os
import glob
import logging

logger = logging.getLogger(__name__)


def load_mcp_configs():
    """Load and merge MCP configurations from tool-specific config.json files."""
    # Start with empty configuration - no more default.json
    mcp_servers = {}
     
    # Find and merge tool-specific configurations
    current_dir = os.path.dirname(os.path.abspath(__file__))
    tool_config_files = glob.glob(os.path.join(current_dir, "*/config.json"))
    for config_file in tool_config_files:
        try:
            with open(config_file, "r") as f:
                tool_config = json.load(f)
                tool_mcp_servers = tool_config.get("mcp_servers", {})
                # Merge tool-specific servers into main configuration
                mcp_servers.update(tool_mcp_servers)
        except (json.JSONDecodeError, FileNotFoundError) as e:
            logger.warning(f"Could not load MCP config from {config_file}: {e}")
    
    return {"mcpServers": mcp_servers}