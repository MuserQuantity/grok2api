"""
Reverse interface: media post create.
"""

import asyncio
import json
import urllib.request
from dataclasses import dataclass
from typing import Any
from curl_cffi.requests import AsyncSession

from app.core.logger import logger
from app.core.config import get_config
from app.core.exceptions import UpstreamException
from app.services.token.service import TokenService
from app.services.reverse.utils.headers import build_headers
from app.services.reverse.utils.retry import retry_on_status

MEDIA_POST_API = "https://grok.com/rest/media/post/create"
class MediaPostReverse:
    """/rest/media/post/create reverse interface."""

    @dataclass
    class _SimpleResponse:
        status_code: int
        headers: dict[str, str]
        text: str

        def json(self):
            return json.loads(self.text or "{}")

    @staticmethod
    async def _urllib_post(
        url: str, headers: dict[str, str], payload: dict[str, Any], timeout: int, proxy_url: str
    ) -> "MediaPostReverse._SimpleResponse":
        body = json.dumps(payload).encode("utf-8")
        opener = None
        if proxy_url:
            opener = urllib.request.build_opener(
                urllib.request.ProxyHandler({"http": proxy_url, "https": proxy_url})
            )
        req = urllib.request.Request(url=url, data=body, headers=headers, method="POST")

        def _do_post():
            if opener is not None:
                with opener.open(req, timeout=timeout) as resp:
                    status = int(getattr(resp, "status", 200) or 200)
                    raw_headers = {
                        str(k).lower(): str(v) for k, v in dict(resp.headers.items()).items()
                    }
                    text = resp.read().decode("utf-8", errors="replace")
                    return status, raw_headers, text
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                status = int(getattr(resp, "status", 200) or 200)
                raw_headers = {
                    str(k).lower(): str(v) for k, v in dict(resp.headers.items()).items()
                }
                text = resp.read().decode("utf-8", errors="replace")
                return status, raw_headers, text

        status, raw_headers, text = await asyncio.to_thread(_do_post)
        return MediaPostReverse._SimpleResponse(
            status_code=status,
            headers=raw_headers,
            text=text,
        )

    @staticmethod
    async def request(
        session: AsyncSession,
        token: str,
        mediaType: str,
        mediaUrl: str,
        prompt: str = "",
    ) -> Any:
        """Create media post in Grok.

        Args:
            session: AsyncSession, the session to use for the request.
            token: str, the SSO token.
            mediaType: str, the media type.
            mediaUrl: str, the media URL.

        Returns:
            Any: The response from the request.
        """
        try:
            # Get proxies
            base_proxy = get_config("proxy.base_proxy_url")
            proxies = {"http": base_proxy, "https": base_proxy} if base_proxy else None
            proxy_url = base_proxy

            # Build headers
            headers = build_headers(
                cookie_token=token,
                content_type="application/json",
                origin="https://grok.com",
                referer="https://grok.com",
            )

            # Build payload
            payload = {"mediaType": mediaType}
            if mediaUrl:
                payload["mediaUrl"] = mediaUrl
            if prompt:
                payload["prompt"] = prompt
            logger.info(
                "MediaPost request prepared: "
                f"mediaType={mediaType}, has_media_url={bool(mediaUrl)}, prompt_len={len(prompt or '')}"
            )

            # Curl Config
            timeout = get_config("video.timeout")
            browser = get_config("proxy.browser")

            async def _do_request():
                try:
                    response = await session.post(
                        MEDIA_POST_API,
                        headers=headers,
                        json=payload,
                        timeout=timeout,
                        proxies=proxies,
                        impersonate=browser,
                    )
                except Exception as first_err:
                    logger.warning(
                        "MediaPostReverse primary request failed, fallback direct: "
                        f"error={first_err}"
                    )
                    try:
                        response = await session.post(
                            MEDIA_POST_API,
                            headers=headers,
                            json=payload,
                            timeout=timeout,
                        )
                    except Exception as second_err:
                        logger.warning(
                            "MediaPostReverse direct curl request failed, "
                            f"fallback urllib: error={second_err}"
                        )
                        response = await MediaPostReverse._urllib_post(
                            url=MEDIA_POST_API,
                            headers=headers,
                            payload=payload,
                            timeout=timeout,
                            proxy_url=proxy_url,
                        )

                if response.status_code != 200:
                    content = ""
                    try:
                        content = (response.text or "").strip().replace("\n", " ")
                    except Exception:
                        pass
                    if len(content) > 300:
                        content = f"{content[:300]}...(len={len(content)})"
                    logger.error(
                        "MediaPostReverse: Media post create failed, "
                        f"status={response.status_code}, body={content or '-'}",
                        extra={"error_type": "UpstreamException"},
                    )
                    raise UpstreamException(
                        message=f"MediaPostReverse: Media post create failed, {response.status_code}",
                        details={"status": response.status_code, "body": content},
                    )

                return response

            return await retry_on_status(_do_request)

        except Exception as e:
            # Handle upstream exception
            if isinstance(e, UpstreamException):
                status = None
                if e.details and "status" in e.details:
                    status = e.details["status"]
                else:
                    status = getattr(e, "status_code", None)
                if status == 401:
                    try:
                        await TokenService.record_fail(token, status, "media_post_auth_failed")
                    except Exception:
                        pass
                raise

            # Handle other non-upstream exceptions
            logger.error(
                f"MediaPostReverse: Media post create failed, {str(e)}",
                extra={"error_type": type(e).__name__},
            )
            raise UpstreamException(
                message=f"MediaPostReverse: Media post create failed, {str(e)}",
                details={"status": 502, "error": str(e)},
            )


__all__ = ["MediaPostReverse"]
