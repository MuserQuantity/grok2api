"""
Grok Voice Mode Service
"""

from typing import Any, Dict

from curl_cffi.requests import AsyncSession

from app.core.config import get_config
from app.services.reverse.ws_livekit import LivekitTokenReverse


class VoiceService:
    """Voice Mode Service (LiveKit)"""

    async def get_token(
        self,
        token: str,
        voice: str = "ara",
        personality: str = "assistant",
        speed: float = 1.0,
    ) -> Dict[str, Any]:
        browser = get_config("proxy.browser")
        async with AsyncSession(impersonate=browser) as session:
            response = await LivekitTokenReverse.request(
                session,
                token=token,
                voice=voice,
                personality=personality,
                speed=speed,
            )
            return response.json()
