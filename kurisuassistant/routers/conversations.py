"""Conversation management routes."""

import json
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from kurisuassistant.core.deps import get_db, get_authenticated_user
from kurisuassistant.db.service import get_db_service
from kurisuassistant.db.models import User
from kurisuassistant.db.repositories import ConversationRepository, MessageRepository

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/conversations", tags=["conversations"])


@router.get("")
async def list_conversations(
    limit: int = 50,
    agent_id: Optional[int] = Query(
        None,
        description="Filter by main_agent_id (returns latest conversation with this main agent)",
    ),
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
):
    """List user's conversations. If agent_id is provided, returns the latest
    conversation whose ``main_agent_id`` matches.
    """
    try:
        def _list(session):
            conv_repo = ConversationRepository(session)
            if agent_id is not None:
                conversation = conv_repo.get_latest_by_agent(user.id, agent_id)
                if conversation:
                    return [{
                        "id": conversation.id,
                        "title": conversation.title or "New conversation",
                        "main_agent_id": conversation.main_agent_id,
                        "created_at": conversation.created_at.isoformat() + "Z",
                        "updated_at": (
                            conversation.updated_at.isoformat() + "Z"
                            if conversation.updated_at
                            else conversation.created_at.isoformat() + "Z"
                        ),
                    }]
                return []
            return conv_repo.list_by_user(user.id, limit)

        db = get_db_service()
        return await db.execute(_list)
    except Exception as e:
        logger.error(f"Error listing conversations for user {user.username}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{conversation_id}")
async def get_conversation(
    conversation_id: int,
    limit: int = 20,
    offset: int = 0,
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
):
    """Get conversation details with messages."""
    try:
        def _get(session):
            conv_repo = ConversationRepository(session)
            msg_repo = MessageRepository(session)

            conversation = conv_repo.get_by_user_and_id(user.id, conversation_id)
            if not conversation:
                raise HTTPException(status_code=404, detail="Conversation not found")

            total_messages = msg_repo.count_by_conversation(conversation_id)
            messages = msg_repo.get_by_conversation(conversation_id, limit, offset)

            messages_array = []
            for msg in messages:
                message_dict = {
                    "id": msg.id,
                    "role": msg.role,
                    "content": msg.message,
                    "created_at": msg.created_at.isoformat() + "Z",
                    "has_raw_data": bool(msg.raw_input or msg.raw_output),
                }
                if msg.name:
                    message_dict["name"] = msg.name
                if msg.images:
                    message_dict["images"] = msg.images
                if msg.thinking:
                    message_dict["thinking"] = msg.thinking
                if getattr(msg, 'model_name', None):
                    message_dict["model_name"] = msg.model_name
                if getattr(msg, 'provider_type', None):
                    message_dict["provider_type"] = msg.provider_type
                if getattr(msg, 'tool_args', None):
                    message_dict["tool_args"] = msg.tool_args
                if getattr(msg, 'tool_status', None):
                    message_dict["tool_status"] = msg.tool_status
                if getattr(msg, 'context_files', None):
                    message_dict["context_files"] = msg.context_files
                if msg.agent_id:
                    message_dict["agent_id"] = msg.agent_id
                    if msg.agent:
                        message_dict["agent"] = {
                            "id": msg.agent.id,
                            "name": msg.agent.name,
                            "avatar_uuid": msg.agent.avatar_uuid,
                            "voice_reference": msg.agent.voice_reference,
                        }
                messages_array.append(message_dict)

            from kurisuassistant.utils.prompts import build_system_messages
            sys_msgs = build_system_messages(user.system_prompt or "", user.preferred_name)
            sys_words = sum(len(m.get("content", "").split()) for m in sys_msgs)
            system_prompt_token_count = int(sys_words * 1.3)

            return {
                "id": conversation.id,
                "messages": messages_array,
                "main_agent_id": conversation.main_agent_id,
                "created_at": conversation.created_at.isoformat() + "Z",
                "title": conversation.title or "",
                "total_messages": total_messages,
                "offset": offset,
                "limit": limit,
                "has_more": offset + len(messages_array) < total_messages,
                "compacted_up_to_id": conversation.compacted_up_to_id or 0,
                "compacted_context": conversation.compacted_context or "",
                "system_prompt_token_count": system_prompt_token_count,
            }

        db = get_db_service()
        return await db.execute(_get)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching conversation {conversation_id} for user {user.username}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/{conversation_id}")
async def update_conversation(
    conversation_id: int,
    request: Request,
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
):
    """Update conversation title."""
    try:
        payload = await request.json()
        title = payload.get("title")

        if not title:
            raise HTTPException(status_code=400, detail="Title is required")

        db = get_db_service()
        await db.execute(
            lambda s: ConversationRepository(s).update_title(user.id, title, conversation_id)
        )

        return {"message": "Conversation title updated successfully"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating conversation {conversation_id} for user {user.username}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{conversation_id}")
async def delete_conversation(
    conversation_id: int,
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
):
    """Delete conversation and all its messages."""
    try:
        db = get_db_service()
        result = await db.execute(
            lambda s: ConversationRepository(s).delete_by_user_and_id(user.id, conversation_id)
        )

        if result:
            return {"message": "Conversation deleted successfully"}
        else:
            raise HTTPException(status_code=404, detail="Conversation not found")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting conversation {conversation_id} for user {user.username}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{conversation_id}/context-breakdown")
async def get_context_breakdown(
    conversation_id: int,
    agent_id: Optional[int] = Query(
        None,
        description="Agent ID (defaults to the conversation's main_agent_id)",
    ),
    user: User = Depends(get_authenticated_user),
):
    """Context breakdown showing token usage for each component."""
    from kurisuassistant.db.repositories import AgentRepository
    from kurisuassistant.tools import tool_registry
    from kurisuassistant.agents.base import estimate_tokens

    try:
        def _get_breakdown(session):
            conv_repo = ConversationRepository(session)
            msg_repo = MessageRepository(session)
            agent_repo = AgentRepository(session)

            conversation = conv_repo.get_by_user_and_id(user.id, conversation_id)
            if not conversation:
                raise HTTPException(status_code=404, detail="Conversation not found")

            # Pick the agent: explicit param > conversation.main_agent_id > first enabled main
            target_agent_id = agent_id or conversation.main_agent_id
            agent = None
            if target_agent_id:
                agent = agent_repo.get_by_user_and_id(user.id, target_agent_id)
                if not agent:
                    agent = agent_repo.get_by_id(target_agent_id)
                    if not agent or not agent.is_system:
                        agent = None
            if agent is None:
                agents = agent_repo.list_enabled_for_user(user.id)
                main_agents = [a for a in agents if a.agent_type == 'main']
                if not main_agents:
                    raise HTTPException(status_code=404, detail="No main agents available")
                agent = main_agents[0]

            import datetime
            base_prompt = f"You are {agent.name}."
            if agent.system_prompt:
                base_prompt += "\n\n" + agent.system_prompt
            if user.system_prompt:
                base_prompt += "\n\n" + user.system_prompt
            if agent.preferred_name or user.preferred_name:
                pref = agent.preferred_name or user.preferred_name
                base_prompt += f"\n\nThe user prefers to be called: {pref}"
            base_prompt += f"\n\nCurrent time: {datetime.datetime.utcnow().isoformat()}"
            system_prompt_tokens = estimate_tokens(base_prompt)

            memory_tokens = 0
            if agent.memory_enabled and agent.memory:
                memory_tokens = estimate_tokens("Your memory:\n" + agent.memory)

            compacted_context_tokens = 0
            if conversation.compacted_context:
                compacted_context_tokens = estimate_tokens("Conversation context:\n" + conversation.compacted_context)

            skills_tokens = 0
            loaded_skills = []
            try:
                from kurisuassistant.tools.skills import get_skill_names_for_user
                skill_names = get_skill_names_for_user(user.id)
                if skill_names:
                    loaded_skills = skill_names
                    skills_text = (
                        "## Skills\n"
                        "You have the following skills: " + ", ".join(skill_names) + ".\n"
                        "Skills contain detailed instructions on HOW to perform specific tasks."
                    )
                    skills_tokens = estimate_tokens(skills_text)
            except Exception:
                pass

            tools_guidance_tokens = 0
            if agent.use_deferred_tools:
                tools_guidance_tokens = estimate_tokens(
                    "## Tool Usage\nYou have access to tools through a discovery system..."
                )

            watermark = conversation.compacted_up_to_id or 0
            messages = msg_repo.list_by_conversation_after(conversation_id, watermark)
            message_history_tokens = 0
            for msg in messages:
                message_history_tokens += estimate_tokens(msg.message or "")
                if msg.thinking:
                    message_history_tokens += estimate_tokens(msg.thinking)

            allowed = set(agent.available_tools) if agent.available_tools else None
            tool_schemas = tool_registry.get_schemas(allowed)
            tool_schemas_tokens = estimate_tokens(json.dumps(tool_schemas, ensure_ascii=False))
            loaded_tools = [t.get("function", {}).get("name", "unknown") for t in tool_schemas]

            total_tokens = (
                system_prompt_tokens + memory_tokens + compacted_context_tokens +
                skills_tokens + tools_guidance_tokens + message_history_tokens +
                tool_schemas_tokens
            )

            return {
                "conversation_id": conversation_id,
                "agent_id": agent.id,
                "agent_name": agent.name,
                "system_prompt_tokens": system_prompt_tokens,
                "memory_tokens": memory_tokens,
                "compacted_context_tokens": compacted_context_tokens,
                "skills_tokens": skills_tokens,
                "tools_guidance_tokens": tools_guidance_tokens,
                "other_agents_tokens": 0,
                "message_history_tokens": message_history_tokens,
                "message_count": len(messages),
                "tool_schemas_tokens": tool_schemas_tokens,
                "tool_count": len(tool_schemas),
                "total_tokens": total_tokens,
                "context_limit": user.context_size or 8192,
                "loaded_tools": loaded_tools,
                "loaded_skills": loaded_skills,
                "_allowed_tools": list(allowed) if allowed else None,
            }

        db = get_db_service()
        result = await db.execute(_get_breakdown)

        allowed = result.pop("_allowed_tools", None)
        try:
            from kurisuassistant.mcp_tools.orchestrator import get_user_orchestrator
            mcp_tools = await get_user_orchestrator(user.id).get_tools()
            if mcp_tools:
                if allowed is not None:
                    allowed_set = set(allowed)
                    mcp_tools = [t for t in mcp_tools if t.get("function", {}).get("name") in allowed_set]
                mcp_tool_names = [t.get("function", {}).get("name", "unknown") for t in mcp_tools]
                result["loaded_tools"].extend(mcp_tool_names)
                result["tool_count"] = len(result["loaded_tools"])
                mcp_tokens = estimate_tokens(json.dumps(mcp_tools, ensure_ascii=False))
                result["tool_schemas_tokens"] += mcp_tokens
                result["total_tokens"] += mcp_tokens
        except Exception:
            pass

        return result

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting context breakdown for conversation {conversation_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
