"""Public Chat router (public_key protected)."""

from fastapi import APIRouter, Depends, Request

from app.core.auth import verify_public_key
from app.api.v1.chat import ChatCompletionRequest, chat_completions

router = APIRouter(tags=["Public Chat"])


@router.post("/chat/completions", dependencies=[Depends(verify_public_key)])
async def public_chat_completions(request: ChatCompletionRequest, raw_request: Request):
    """Public chat completions endpoint."""
    return await chat_completions(request, raw_request)


__all__ = ["router"]
