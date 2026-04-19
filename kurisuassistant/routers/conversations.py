"""Conversation management routes."""

import logging

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from kurisuassistant.core.deps import get_db, get_authenticated_user
from kurisuassistant.db.service import get_db_service
from kurisuassistant.db.models import User
from kurisuassistant.db.repositories import ConversationRepository, MessageRepository, FrameRepository

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/conversations", tags=["conversations"])


@router.get("")
async def list_conversations(
    limit: int = 50,
    agent_id: Optional[int] = Query(None, description="Filter by agent ID (returns latest conversation with messages from this agent)"),
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db)
):
    """List user's conversations. If agent_id is provided, returns the latest conversation containing messages from that agent."""
    try:
        def _list(session):
            conv_repo = ConversationRepository(session)
            if agent_id is not None:
                conversation = conv_repo.get_latest_by_agent(user.id, agent_id)
                if conversation:
                    return [{
                        "id": conversation.id,
                        "title": conversation.title or "New conversation",
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
    db: Session = Depends(get_db)
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
            frame_ids = set()
            for msg in messages:
                message_dict = {
                    "id": msg.id,
                    "role": msg.role,
                    "content": msg.message,
                    "frame_id": msg.frame_id,
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
                    # Include agent info if available (eager loaded)
                    if msg.agent:
                        persona = msg.agent.persona
                        message_dict["agent"] = {
                            "id": msg.agent.id,
                            "name": msg.agent.name,
                            "persona_name": persona.name if persona else None,
                            "avatar_uuid": persona.avatar_uuid if persona else None,
                            "voice_reference": persona.voice_reference if persona else None,
                        }
                messages_array.append(message_dict)
                if msg.frame_id:
                    frame_ids.add(msg.frame_id)

            # Build frames map for frame IDs referenced by returned messages
            from kurisuassistant.db.models import Frame
            frames_map = {}
            if frame_ids:
                frames = session.query(Frame).filter(Frame.id.in_(frame_ids)).all()
                for f in frames:
                    frames_map[f.id] = {
                        "id": f.id,
                        "summary": f.summary,
                        "created_at": f.created_at.isoformat() + "Z" if f.created_at else None,
                        "updated_at": f.updated_at.isoformat() + "Z" if f.updated_at else None,
                    }

            # Estimate system prompt tokens (word_count * 1.3)
            from kurisuassistant.utils.prompts import build_system_messages
            sys_msgs = build_system_messages(user.system_prompt or "", user.preferred_name)
            sys_words = sum(len(m.get("content", "").split()) for m in sys_msgs)
            system_prompt_token_count = int(sys_words * 1.3)

            return {
                "id": conversation.id,
                "messages": messages_array,
                "frames": frames_map,
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
    db: Session = Depends(get_db)
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
    db: Session = Depends(get_db)
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


@router.get("/{conversation_id}/frames")
async def list_frames(
    conversation_id: int,
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db)
):
    """List all frames in a conversation with metadata."""
    try:
        def _list_frames(session):
            conv_repo = ConversationRepository(session)
            frame_repo = FrameRepository(session)

            conversation = conv_repo.get_by_user_and_id(user.id, conversation_id)
            if not conversation:
                raise HTTPException(status_code=404, detail="Conversation not found")

            frames = frame_repo.list_by_conversation(conversation_id)
            return {"frames": frames}

        db = get_db_service()
        return await db.execute(_list_frames)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error listing frames for conversation {conversation_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{conversation_id}/context-breakdown")
async def get_context_breakdown(
    conversation_id: int,
    agent_id: Optional[int] = Query(None, description="Agent ID (uses first enabled agent if not provided)"),
    user: User = Depends(get_authenticated_user),
):
    """Get context breakdown showing token usage for each component.

    Returns estimated token counts for system prompt, memory, skills,
    tools, message history, etc.
    """
    from kurisuassistant.db.repositories import AgentRepository
    from kurisuassistant.tools import tool_registry
    from kurisuassistant.agents.base import estimate_tokens
    import json

    try:
        def _get_breakdown(session):
            conv_repo = ConversationRepository(session)
            msg_repo = MessageRepository(session)
            agent_repo = AgentRepository(session)

            # Verify conversation belongs to user
            conversation = conv_repo.get_by_user_and_id(user.id, conversation_id)
            if not conversation:
                raise HTTPException(status_code=404, detail="Conversation not found")

            # Get agent
            if agent_id:
                agent = agent_repo.get_by_user_and_id(user.id, agent_id)
                if not agent:
                    # Try system agent
                    agent = agent_repo.get_by_id(agent_id)
                    if not agent or not agent.is_system:
                        raise HTTPException(status_code=404, detail="Agent not found")
            else:
                # Get first enabled main agent
                agents = agent_repo.list_enabled_for_user(user.id)
                main_agents = [a for a in agents if a.agent_type == 'main' and not a.is_system]
                if not main_agents:
                    raise HTTPException(status_code=404, detail="No agents available")
                agent = main_agents[0]

            # Build system prompt estimate
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

            # Memory tokens
            memory_tokens = 0
            if agent.memory_enabled and agent.memory:
                memory_text = "Your memory:\n" + agent.memory
                memory_tokens = estimate_tokens(memory_text)

            # Compacted context tokens
            compacted_context_tokens = 0
            if conversation.compacted_context:
                compacted_text = "Conversation context:\n" + conversation.compacted_context
                compacted_context_tokens = estimate_tokens(compacted_text)

            # Skills tokens
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

            # Tools guidance (for deferred tools mode)
            tools_guidance_tokens = 0
            if agent.use_deferred_tools:
                tools_guidance = (
                    "## Tool Usage\n"
                    "You have access to tools through a discovery system..."
                )
                tools_guidance_tokens = estimate_tokens(tools_guidance)

            # Message history
            watermark = conversation.compacted_up_to_id or 0
            messages = msg_repo.list_by_conversation_after(conversation_id, watermark)
            message_history_tokens = 0
            for msg in messages:
                message_history_tokens += estimate_tokens(msg.content or "")
                if msg.thinking:
                    message_history_tokens += estimate_tokens(msg.thinking)

            # Tool schemas (local tools only - MCP tools added outside sync block)
            allowed = set(agent.available_tools) if agent.available_tools else None
            tool_schemas = tool_registry.get_schemas(allowed)

            tool_schemas_json = json.dumps(tool_schemas, ensure_ascii=False)
            tool_schemas_tokens = estimate_tokens(tool_schemas_json)
            loaded_tools = [t.get("function", {}).get("name", "unknown") for t in tool_schemas]

            # Total
            total_tokens = (
                system_prompt_tokens +
                memory_tokens +
                compacted_context_tokens +
                skills_tokens +
                tools_guidance_tokens +
                message_history_tokens +
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
                "other_agents_tokens": 0,  # Not calculated in HTTP context
                "message_history_tokens": message_history_tokens,
                "message_count": len(messages),
                "tool_schemas_tokens": tool_schemas_tokens,
                "tool_count": len(tool_schemas),
                "total_tokens": total_tokens,
                "context_limit": user.context_size or 8192,
                "loaded_tools": loaded_tools,
                "loaded_skills": loaded_skills,
                "_allowed_tools": list(allowed) if allowed else None,  # For MCP filtering
            }

        db = get_db_service()
        result = await db.execute(_get_breakdown)

        # Add MCP tools asynchronously (outside sync block)
        allowed = result.pop("_allowed_tools", None)  # Remove internal key
        try:
            from kurisuassistant.mcp_tools.orchestrator import get_user_orchestrator
            mcp_tools = await get_user_orchestrator(user.id).get_tools()
            if mcp_tools:
                if allowed is not None:
                    allowed_set = set(allowed)
                    mcp_tools = [t for t in mcp_tools if t.get("function", {}).get("name") in allowed_set]
                # Add MCP tool names to loaded_tools
                mcp_tool_names = [t.get("function", {}).get("name", "unknown") for t in mcp_tools]
                result["loaded_tools"].extend(mcp_tool_names)
                result["tool_count"] = len(result["loaded_tools"])
                # Add MCP tools token count
                mcp_tokens = estimate_tokens(json.dumps(mcp_tools, ensure_ascii=False))
                result["tool_schemas_tokens"] += mcp_tokens
                result["total_tokens"] += mcp_tokens
        except Exception:
            pass  # MCP tools are optional

        return result

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting context breakdown for conversation {conversation_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
