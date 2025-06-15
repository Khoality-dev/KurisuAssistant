from fastmcp import FastMCP
from typing import Annotated, List
from pydantic import Field
import datetime
import subprocess

mcp = FastMCP(
    "Clock Service",
    description="MCP server providing date/time retrieval."
)

@mcp.tool()
def get_date_time() -> str:
    """Get the current date and time."""
    # Return ISO-formatted timestamp
    return datetime.datetime.now().isoformat()
 
# 3. Run the server with HTTP endpoints
if __name__ == "__main__":
    # Expose endpoints under /mcp on port 8000
    mcp.run()
