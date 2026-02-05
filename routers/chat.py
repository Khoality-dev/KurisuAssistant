"""Chat and LLM routes: /chat, /models, /asr."""

import base64
import datetime
import json
import logging
from typing import List, Optional

import numpy as np
from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session

from core.deps import get_db, oauth2_scheme
from core.security import get_current_user
from db.session import get_session
from db.models import User
from db.repositories import UserRepository, ConversationRepository, FrameRepository, MessageRepository
from llm import chat as llm_chat, list_models as llm_list_models
from utils.prompts import build_system_messages
from utils.images import upload_image

logger = logging.getLogger(__name__)

router = APIRouter(tags=["chat"])

# ASR model is initialized in main.py and passed to this router
asr_model = None
SAMPLE_RATE = 16_000


def set_asr_model(model):
    """Set the ASR model from main.py."""
    global asr_model
    asr_model = model


@router.post("/asr", tags=["asr"])
async def asr(
    audio: bytes = Body(..., media_type="application/octet-stream"),
    token: str = Depends(oauth2_scheme),
):
    """Convert audio to text using Whisper."""
    if not get_current_user(token):
        raise HTTPException(status_code=401, detail="Invalid token")
    try:
        pcm = np.frombuffer(audio, dtype=np.int16)
        waveform = pcm.astype(np.float32) / 32768.0
        result = asr_model(waveform)
        text = result["text"]
        return {"text": text}
    except Exception as e:
        logger.error(f"Error processing ASR request: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/chat")
async def chat(
    text: str = Form(...),
    model_name: str = Form(...),
    conversation_id: int = Form(None),
    images: list[UploadFile] = File(default=[]),
    token: str = Depends(oauth2_scheme)
):
    """Stream chat responses with LLM."""
    username = get_current_user(token)
    if not username:
        raise HTTPException(status_code=401, detail="Invalid token")

    try:
        with get_session() as session:
            # Get user for user_id
            user_repo = UserRepository(session)
            user = user_repo.get_by_username(username)
            if not user:
                raise HTTPException(status_code=401, detail="User not found")
            user_id = user.id

            conv_repo = ConversationRepository(session)
            frame_repo = FrameRepository(session)

            # Auto-create conversation if needed
            if conversation_id is None:
                conversation = conv_repo.create_conversation(user_id)
                actual_conversation_id = conversation.id
            else:
                # Verify ownership
                conversation = conv_repo.get_by_user_and_id(user_id, conversation_id)
                if not conversation:
                    raise HTTPException(status_code=404, detail="Conversation not found")
                actual_conversation_id = conversation_id

            user_message_content = text
            image_data = []

            # Handle image attachments if provided
            if images:
                valid_images = [img for img in images if img.size > 0]
                if valid_images:
                    image_markdowns = []
                    for image in valid_images:
                        image_uuid = upload_image(image)
                        image_url = f"/images/{image_uuid}"
                        image_markdowns.append(f"![Image]({image_url})")

                        image.file.seek(0)
                        image_bytes = image.file.read()
                        image_b64 = base64.b64encode(image_bytes).decode('utf-8')
                        image_data.append(image_b64)

                    if image_markdowns:
                        images_text = "\n\n" + "\n".join(image_markdowns)
                        user_message_content += images_text

            # Get or create frame
            last_frame = frame_repo.get_latest_by_conversation(actual_conversation_id)
            if last_frame:
                actual_frame_id = last_frame.id
            else:
                frame = frame_repo.create_frame(actual_conversation_id)
                actual_frame_id = frame.id

            # Get user preferences
            user_system_prompt, preferred_name = user_repo.get_preferences(user)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error preparing chat request: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

    current_conversation_id = actual_conversation_id
    current_frame_id = actual_frame_id

    # Load context from database
    context_messages = _get_frame_messages(current_conversation_id, current_frame_id)

    system_messages = build_system_messages(user_system_prompt, preferred_name)

    # Create user message
    created_at = datetime.datetime.utcnow()
    user_message = {
        "role": "user",
        "content": user_message_content,
        "created_at": created_at.isoformat(),
    }

    # Build full message list for LLM
    messages = system_messages + context_messages + [user_message]

    # Get tools (disabled for now)
    tools = []

    # Call LLM adapter
    sentence_stream = llm_chat(
        model_name=model_name,
        messages=messages,
        tools=tools,
        images=image_data
    )

    def stream():
        try:
            complete_content = ""
            complete_thinking = None
            last_created_at = None

            for message in sentence_stream:
                wrapped_chunk = {
                    "message": message,
                    "conversation_id": current_conversation_id,
                    "frame_id": current_frame_id
                }
                yield json.dumps(wrapped_chunk) + "\n"

                complete_content += message.get("content", "")
                last_created_at = message.get("created_at")

                if message.get("thinking"):
                    if complete_thinking is None:
                        complete_thinking = message.get("thinking")
                    else:
                        complete_thinking += message.get("thinking")

            # Save messages to database
            try:
                with get_session() as session:
                    msg_repo = MessageRepository(session)
                    frame_repo = FrameRepository(session)
                    conv_repo = ConversationRepository(session)

                    # Save user message
                    msg_repo.create_message(
                        role=user_message["role"],
                        message=user_message["content"],
                        frame_id=current_frame_id,
                        created_at=created_at
                    )

                    # Save assistant response
                    if complete_content:
                        msg_repo.create_message(
                            role="assistant",
                            message=complete_content,
                            frame_id=current_frame_id,
                            thinking=complete_thinking
                        )

                    # Update timestamps
                    frame = frame_repo.get_by_id(current_frame_id)
                    if frame:
                        frame_repo.update_timestamp(frame)

                    conversation = conv_repo.get_by_id(current_conversation_id)
                    if conversation:
                        conv_repo.update_timestamp(conversation)

            except Exception as e:
                logger.error(f"Failed to save messages: {e}")

            yield json.dumps({"done": True}) + "\n"

        except Exception as e:
            logger.error(f"Error in chat stream: {e}")
            error_msg = {
                "message": {
                    "role": "assistant",
                    "content": f"Error: {str(e)}",
                    "created_at": datetime.datetime.utcnow().isoformat(),
                }
            }
            yield json.dumps(error_msg) + "\n"
            yield json.dumps({"done": True}) + "\n"

    return StreamingResponse(stream(), media_type="application/json")


@router.get("/models")
async def models(token: str = Depends(oauth2_scheme)):
    """List available LLM models."""
    if not get_current_user(token):
        raise HTTPException(status_code=401, detail="Invalid token")
    try:
        return {"models": llm_list_models()}
    except Exception as e:
        logger.error(f"Error fetching models from LLM provider: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


def _get_frame_messages(
    conversation_id: Optional[int],
    frame_id: Optional[int]
) -> List[dict]:
    """Load messages from a specific frame."""
    if conversation_id is None or frame_id is None:
        return []

    try:
        with get_session() as session:
            msg_repo = MessageRepository(session)
            frame_repo = FrameRepository(session)

            # Validate frame access
            frame = frame_repo.get_by_id(frame_id)
            if not frame or frame.conversation_id != conversation_id:
                return []

            messages = msg_repo.get_by_frame(frame_id, limit=1000)

            return [
                {
                    "role": msg.role,
                    "content": msg.message,
                    "created_at": msg.created_at.isoformat(),
                    "message_id": msg.id
                }
                for msg in messages
            ]

    except Exception as e:
        logger.error(f"Error loading frame messages: {e}")
        return []
