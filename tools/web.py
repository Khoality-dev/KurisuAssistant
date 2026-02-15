"""Web search tool with SerpAPI (primary) and DuckDuckGo (fallback)."""

import asyncio
import json
import logging
import os
from typing import Dict, Any, List, Optional

from .base import BaseTool

logger = logging.getLogger(__name__)

async def _serpapi_search(query: str, max_results: int) -> Optional[List[Dict[str, str]]]:
    """Search using SerpAPI Google Search. Returns None on failure/quota exceeded."""
    serpapi_key = os.getenv("SERPAPI_KEY", "")
    if not serpapi_key:
        return None

    import aiohttp

    params = {
        "api_key": serpapi_key,
        "engine": "google",
        "q": query,
        "num": min(max_results, 10),
    }

    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(
                "https://serpapi.com/search.json",
                params=params,
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                if resp.status == 429:
                    logger.warning("SerpAPI quota exceeded, falling back to DuckDuckGo")
                    return None
                if resp.status != 200:
                    body = await resp.text()
                    logger.warning(f"SerpAPI error {resp.status}: {body}")
                    return None

                data = await resp.json()
                results = data.get("organic_results", [])
                return [
                    {
                        "title": r.get("title", ""),
                        "url": r.get("link", ""),
                        "body": r.get("snippet", ""),
                    }
                    for r in results[:max_results]
                ]
    except Exception as e:
        logger.warning(f"SerpAPI failed, falling back to DuckDuckGo: {e}")
        return None


async def _duckduckgo_search(query: str, max_results: int) -> List[Dict[str, str]]:
    """Search using DuckDuckGo."""
    from duckduckgo_search import DDGS

    results = await asyncio.to_thread(
        lambda: DDGS().text(query, max_results=max_results)
    )
    return [{"title": r["title"], "url": r["href"], "body": r["body"]} for r in results]


class WebSearchTool(BaseTool):
    """Search the web using SerpAPI (primary) with DuckDuckGo fallback."""

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
        query = args.get("query")
        if not query:
            return json.dumps({"error": "query is required."})

        max_results = args.get("max_results", 5)

        try:
            # Try SerpAPI (Google) first
            results = await _serpapi_search(query, max_results)
            engine = "Google (SerpAPI)"

            # Fall back to DuckDuckGo
            if results is None:
                results = await _duckduckgo_search(query, max_results)
                engine = "DuckDuckGo"

            return json.dumps({"engine": engine, "results": results}, ensure_ascii=False)
        except Exception as e:
            logger.error(f"web_search failed: {e}", exc_info=True)
            return json.dumps({"error": f"Search failed: {e}"})

    def describe_call(self, args: Dict[str, Any]) -> str:
        query = args.get("query", "")
        return f"Web search: {query}"
