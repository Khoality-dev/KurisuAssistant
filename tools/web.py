"""Web search tool using DuckDuckGo."""

import asyncio
import json
import logging
from typing import Dict, Any

from .base import BaseTool

logger = logging.getLogger(__name__)


class WebSearchTool(BaseTool):
    """Search the web using DuckDuckGo."""

    name = "web_search"
    description = (
        "Search the web for current information. "
        "Use when the user asks about recent events, facts you're unsure about, "
        "or anything that benefits from up-to-date web results."
    )
    requires_approval = False
    risk_level = "low"
    built_in = True

    def get_schema(self) -> Dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "The search query.",
                        },
                        "max_results": {
                            "type": "integer",
                            "description": "Maximum number of results to return (default: 5).",
                        },
                    },
                    "required": ["query"],
                },
            },
        }

    async def execute(self, args: Dict[str, Any]) -> str:
        from duckduckgo_search import DDGS

        query = args.get("query")
        if not query:
            return json.dumps({"error": "query is required."})

        max_results = args.get("max_results", 5)

        try:
            results = await asyncio.to_thread(
                lambda: DDGS().text(query, max_results=max_results)
            )
            return json.dumps(
                [{"title": r["title"], "url": r["href"], "body": r["body"]} for r in results],
                ensure_ascii=False,
            )
        except Exception as e:
            logger.error(f"web_search failed: {e}", exc_info=True)
            return json.dumps({"error": f"Search failed: {e}"})

    def describe_call(self, args: Dict[str, Any]) -> str:
        query = args.get("query", "")
        return f"Web search: {query}"
