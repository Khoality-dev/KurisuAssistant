import sys
from fastmcp import FastMCP
from typing import Annotated, List
from pydantic import Field
import datetime
import subprocess

mcp = FastMCP(
    "Home Lighting Service",
    instructions="This server provides utility functions for home lighting control."
)

@mcp.tool()
def change_lights_status(
    action: Annotated[
        str,
        Field(
            description="The action to perform on the lights; must be 'on' or 'off'"
        )
    ]
) -> str:
    """Control the lights status, either on or off."""
    IPs = ['10.0.0.57', '10.0.0.58']
    for IP in IPs:
        subprocess.run(["flux_led", IP, f"--{action}"], )
        #subprocess.run(["flux_led", IP, f"--{action}"], check=True)
    return f"Lights turned {action}."

@mcp.tool()
def change_lights_color(
    color: Annotated[
        str,
        Field(
            description="The RGB color values as a comma-separated string, e.g. '124,21,200'"
        )
    ]
) -> str:
    """Change the light color to the specified RGB values."""
    IPs = ['10.0.0.57', '10.0.0.58']
    for IP in IPs:
        subprocess.run(["flux_led", IP, "-c", color], check=True)
    return f"Light color changed to {color}."

# 3. Run the server with HTTP endpoints
if __name__ == "__main__":
    # Expose endpoints under /mcp on port 8000
    mcp.run()
