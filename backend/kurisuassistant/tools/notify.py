"""``notify_user`` — the assistant reaching the user outside the chat (#353).

A notification on every device of the account, with the app closed, for
something the user should see now: a background or scheduled task's result, a
thing they asked to be told about. It goes through ``notifications.notify``,
the same path as calendar reminders, and links the conversation it came from so
tapping it opens that conversation. It only looks (it changes nothing but what
the user's own devices show) and is allowed by default: it never waits, in any
permission mode — a task with nobody attached (#352) has to be able to say it
is done.
"""

import logging
from typing import Any, Dict

from .base import BaseTool

logger = logging.getLogger(__name__)


class NotifyUserTool(BaseTool):
    name = "notify_user"
    description = (
        "Send a notification to the user's phone and desktop. It arrives even when "
        "the app is closed, and tapping it opens this conversation. Use it for "
        "something the user should see now — the result of a task they are not "
        "watching, or something they asked to be told about — not to repeat a "
        "reply they are reading in the chat."
    )
    read_only = True
    allowed_by_default = True

    def get_schema(self) -> Dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "title": {
                            "type": "string",
                            "description": "A few words: what this is about.",
                        },
                        "body": {
                            "type": "string",
                            "description": "One or two short sentences.",
                        },
                    },
                    "required": ["title", "body"],
                },
            },
        }

    def describe_call(self, args: Dict[str, Any]) -> str:
        return f"Send a notification: {args.get('title', '')}"

    async def execute(self, args: Dict[str, Any]) -> str:
        from kurisuassistant.notifications import notify

        user_id = args.get("user_id")
        if not user_id:
            return "Error: No user context available."
        title = str(args.get("title") or "").strip()
        body = str(args.get("body") or "").strip()
        if not title and not body:
            return "Error: A notification needs a title or a body."
        await notify(
            user_id,
            source="assistant",
            title=title or body,
            body=body if title else "",
            conversation_id=args.get("conversation_id") or None,
        )
        return "Notification sent."
