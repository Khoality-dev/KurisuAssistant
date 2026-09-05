"""User profile management routes."""

import logging

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile

from kurisuassistant.core.errors import internal_error
from kurisuassistant.core.deps import get_authenticated_user
from kurisuassistant.db.service import get_db_service
from kurisuassistant.db.models import User
from kurisuassistant.db.repositories import UserRepository
from kurisuassistant.utils.images import upload_image

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/users", tags=["users"])


@router.get("/me")
async def get_user_profile(
    user: User = Depends(get_authenticated_user)
):
    """Get current user profile.

    Provider API keys are never returned. They are write-only: PATCH sets one,
    and this reports only whether one is configured. Echoing the key back put
    the user's paid third-party credentials into every client that holds a
    token, and into any log or proxy that saw the response.

    ``agent_avatar_uuid`` stays despite personas owning their own ``avatar_uuid``:
    it is the account-level fallback a client shows when the answering persona has
    no avatar of its own, and it is what migration 0dacee9f63b8 copied into the
    persona it seeded for accounts that had none.
    """
    try:
        return {
            "username": user.username,
            "system_prompt": user.system_prompt or "",
            "preferred_name": user.preferred_name or "",
            "agent_avatar_uuid": user.agent_avatar_uuid,
            "ollama_url": user.ollama_url,
            "has_gemini_key": bool(user.gemini_api_key),
            "has_nvidia_key": bool(getattr(user, 'nvidia_api_key', None)),
            "has_poe_key": bool(getattr(user, 'poe_api_key', None)),
            "summary_model": user.summary_model,
            "summary_provider": getattr(user, 'summary_provider', 'ollama') or 'ollama',
            "context_size": user.context_size,
        }
    except Exception as e:
        raise internal_error(e, f"Error fetching user profile for {user.username}")


@router.patch("/me")
async def update_user_profile(
    request: Request,
    user: User = Depends(get_authenticated_user)
):
    """Update user profile fields (text only)."""
    try:
        body = await request.json()
        system_prompt = body.get("system_prompt")
        preferred_name = body.get("preferred_name")
        ollama_url = body.get("ollama_url")
        gemini_api_key = body.get("gemini_api_key")
        nvidia_api_key = body.get("nvidia_api_key")
        poe_api_key = body.get("poe_api_key")
        summary_model = body.get("summary_model")
        summary_provider = body.get("summary_provider")
        context_size = body.get("context_size")

        if any(v is not None for v in [system_prompt, preferred_name, ollama_url, gemini_api_key, nvidia_api_key, poe_api_key, summary_model, summary_provider, context_size]):
            def _update_prefs(session):
                user_repo = UserRepository(session)
                db_user = user_repo.get_by_id(user.id)
                if not db_user:
                    raise ValueError(f"User {user.username} not found")
                user_repo.update_preferences(db_user, system_prompt, preferred_name, ollama_url, summary_model, context_size, gemini_api_key=gemini_api_key, nvidia_api_key=nvidia_api_key, poe_api_key=poe_api_key, summary_provider=summary_provider)

            db = get_db_service()
            await db.execute(_update_prefs)
            return {"status": "ok", "message": "Profile updated successfully"}
        else:
            return {"status": "ok", "message": "No changes"}

    except HTTPException:
        raise
    except Exception as e:
        raise internal_error(e, f"Error updating user profile for {user.username}")


@router.patch("/me/avatars")
async def update_user_avatars(
    agent_avatar: UploadFile = File(None),
    user: User = Depends(get_authenticated_user)
):
    """Update agent avatar image."""
    try:
        # Process avatar outside DB session (I/O bound)
        avatar_uuid = None
        should_update = False
        if agent_avatar is not None and agent_avatar.filename:
            try:
                file_size = agent_avatar.size if hasattr(agent_avatar, 'size') else 0
                if file_size > 0:
                    avatar_uuid = upload_image(agent_avatar)
                    should_update = True
                else:
                    avatar_uuid = None
                    should_update = True
            except HTTPException:
                raise
            except Exception as e:
                # The decoder's message can carry a server path, so it is logged
                # rather than returned; the caller only needs to know it failed.
                raise internal_error(
                    e, "processing an agent avatar", status_code=400,
                    public_detail="That file could not be read as an image.",
                )

        def _update_avatar(session):
            user_repo = UserRepository(session)
            db_user = user_repo.get_by_id(user.id)
            if not db_user:
                raise HTTPException(status_code=404, detail="User not found")
            if should_update:
                user_repo.update_avatar(db_user, avatar_uuid)
            return db_user.agent_avatar_uuid

        db = get_db_service()
        result_uuid = await db.execute(_update_avatar)
        return {"status": "ok", "agent_avatar_uuid": result_uuid}

    except HTTPException:
        raise
    except Exception as e:
        raise internal_error(e, f"Error updating avatars for {user.username}")


@router.get("/me/tool-policies")
async def get_tool_policies(
    user: User = Depends(get_authenticated_user)
):
    """Get user's tool permission policies."""
    return user.tool_policies or {"tools": {}}


@router.put("/me/tool-policies")
async def update_tool_policies(
    request: Request,
    user: User = Depends(get_authenticated_user)
):
    """Update user's tool permission policies."""
    try:
        body = await request.json()
        tools = body.get("tools", {})

        # Validate: each tool policy must be "allow" or "deny"
        for tool_name, policy in tools.items():
            if policy not in ("allow", "deny"):
                raise HTTPException(
                    status_code=400,
                    detail=f"Invalid policy for {tool_name}: must be 'allow' or 'deny'"
                )

        def _update_policies(session):
            user_repo = UserRepository(session)
            db_user = user_repo.get_by_id(user.id)
            if not db_user:
                raise HTTPException(status_code=404, detail="User not found")
            db_user.tool_policies = {"tools": tools}

        db = get_db_service()
        await db.execute(_update_policies)
        return {"status": "ok"}

    except HTTPException:
        raise
    except Exception as e:
        raise internal_error(e, f"Error updating tool policies for {user.username}")


@router.patch("/me/tool-policies")
async def patch_tool_policy(
    request: Request,
    user: User = Depends(get_authenticated_user)
):
    """Update a single tool's permission policy (incremental update)."""
    try:
        body = await request.json()
        tool_name = body.get("tool_name")
        policy = body.get("policy")  # "allow", "deny", or null to remove

        if not tool_name:
            raise HTTPException(status_code=400, detail="tool_name is required")

        if policy is not None and policy not in ("allow", "deny"):
            raise HTTPException(status_code=400, detail="policy must be 'allow', 'deny', or null")

        def _patch_policy(session):
            user_repo = UserRepository(session)
            db_user = user_repo.get_by_id(user.id)
            if not db_user:
                raise HTTPException(status_code=404, detail="User not found")

            current = db_user.tool_policies or {"tools": {}}
            tools = dict(current.get("tools", {}))  # Copy to ensure mutation detection

            if policy is None:
                # Remove the policy
                tools.pop(tool_name, None)
            else:
                tools[tool_name] = policy

            # Assign new dict to trigger SQLAlchemy change detection
            db_user.tool_policies = {"tools": tools}

        db = get_db_service()
        await db.execute(_patch_policy)
        return {"status": "ok"}

    except HTTPException:
        raise
    except Exception as e:
        raise internal_error(e, f"Error patching tool policy for {user.username}")
