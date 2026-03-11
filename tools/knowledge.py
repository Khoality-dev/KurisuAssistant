"""Knowledge graph query tool."""

import json
import logging
from typing import Dict, Any

from .base import BaseTool

logger = logging.getLogger(__name__)


class QueryKnowledgeTool(BaseTool):
    """Search the user's knowledge graph for information from past conversations."""

    name = "query_knowledge"
    description = (
        "Search the user's knowledge graph for information about people, places, "
        "preferences, concepts, and events mentioned in past conversations."
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
                            "description": "Natural language question to search for in the knowledge graph.",
                        },
                        "mode": {
                            "type": "string",
                            "enum": ["hybrid", "local", "global"],
                            "description": "Search mode: 'hybrid' (default, combines local+global), 'local' (entity-focused), 'global' (high-level themes).",
                        },
                    },
                    "required": ["query"],
                },
            },
        }

    async def execute(self, args: Dict[str, Any]) -> str:
        from db.session import get_session
        from db.models import User
        from utils.knowledge_graph import query_knowledge

        user_id = args.get("user_id")
        if not user_id:
            return json.dumps({"error": "No user context available."})

        query = args.get("query")
        if not query:
            return json.dumps({"error": "query is required."})

        mode = args.get("mode", "hybrid")
        if mode not in ("hybrid", "local", "global"):
            mode = "hybrid"

        try:
            # Get user's model config
            with get_session() as session:
                user = session.query(User).filter_by(id=user_id).first()
                if not user:
                    return json.dumps({"error": "User not found."})
                summary_model = user.summary_model
                ollama_url = user.ollama_url

            if not summary_model:
                return json.dumps({"error": "No summary model configured. Knowledge graph requires a summary model."})

            result = await query_knowledge(
                user_id=user_id,
                question=query,
                model_name=summary_model,
                mode=mode,
                api_url=ollama_url,
            )
            return result if result else json.dumps({"info": "No relevant knowledge found."})

        except Exception as e:
            logger.error(f"query_knowledge tool failed: {e}", exc_info=True)
            return json.dumps({"error": f"Knowledge graph query failed: {e}"})

    def describe_call(self, args: Dict[str, Any]) -> str:
        query = args.get("query", "?")
        mode = args.get("mode", "hybrid")
        return f"Query knowledge graph ({mode}): {query}"
