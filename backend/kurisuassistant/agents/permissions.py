"""The account's permission mode (#360): the whole of tool permission.

Every tool is always offered to the model. What the mode decides is what happens
when one is called, from whether the tool only looks:

| mode        | only looks | changes something |
| ----------- | ---------- | ----------------- |
| ``ask``     | ask        | ask               |
| ``read_only`` | run      | refuse            |
| ``full``    | run        | run               |

``ask`` is the default for every account. A value this module does not know —
``auto`` is shown by the clients as coming soon but is not stored — asks.
"""

from typing import Literal

PERMISSION_MODES = ("ask", "read_only", "full")
DEFAULT_PERMISSION_MODE = "ask"

PermissionMode = Literal["ask", "read_only", "full"]
Decision = Literal["run", "ask", "refuse"]


def decide(mode: str, read_only: bool) -> Decision:
    """What the mode does with a call to a tool that does (or does not) only look."""
    if mode == "full":
        return "run"
    if mode == "read_only":
        return "run" if read_only else "refuse"
    return "ask"
