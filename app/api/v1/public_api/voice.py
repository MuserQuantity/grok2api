import asyncio
from typing import Any
from urllib.parse import urlencode, urlparse, urlunparse

import aiohttp
from fastapi import APIRouter, Depends
from fastapi import Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from app.core.auth import verify_public_key
from app.core.config import get_config
from app.core.exceptions import AppException
from app.core.logger import logger
from app.services.grok.services.voice import VoiceService
from app.services.reverse.utils.headers import build_ws_headers
from app.services.reverse.utils.websocket import WebSocketClient
from app.services.token.manager import get_token_manager

router = APIRouter()
DEFAULT_LIVEKIT_URL = "wss://livekit.grok.com"


class VoiceTokenResponse(BaseModel):
    token: str
    url: str
    urls: list[str] | None = None
    participant_name: str = ""
    room_name: str = ""
    ice_servers: list[dict[str, Any]] | None = None
    signal_proxy_url: str | None = None


def _deep_get(data: dict[str, Any], path: tuple[str, ...]) -> Any:
    """按路径安全读取嵌套字段。"""
    node: Any = data
    for key in path:
        if not isinstance(node, dict):
            return None
        node = node.get(key)
    return node


def _first_string(data: dict[str, Any], paths: list[tuple[str, ...]]) -> str:
    """按优先级获取第一个非空字符串字段。"""
    for path in paths:
        value = _deep_get(data, path)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _normalize_ice_servers(raw: Any) -> list[dict[str, Any]]:
    """归一化 ICE servers，兼容 url/urls 多种结构。"""
    if not isinstance(raw, list):
        return []

    result: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue

        urls_value = item.get("urls")
        if urls_value is None:
            urls_value = item.get("url")

        urls: list[str] = []
        if isinstance(urls_value, str) and urls_value.strip():
            urls = [urls_value.strip()]
        elif isinstance(urls_value, list):
            urls = [u.strip() for u in urls_value if isinstance(u, str) and u.strip()]

        if not urls:
            continue

        normalized: dict[str, Any] = {"urls": urls}
        username = item.get("username")
        credential = item.get("credential")
        if isinstance(username, str) and username.strip():
            normalized["username"] = username.strip()
        if credential is not None:
            normalized["credential"] = credential
        result.append(normalized)

    return result


def _normalize_ws_url(raw: Any) -> str:
    """规范化 ws/wss URL，保留协议、主机与路径。"""
    if not isinstance(raw, str):
        return ""
    value = raw.strip()
    if not value:
        return ""
    if "://" not in value:
        value = f"wss://{value}"
    try:
        parsed = urlparse(value)
        if parsed.scheme not in ("ws", "wss") or not parsed.netloc:
            return ""
        path = (parsed.path or "").rstrip("/")
        return urlunparse((parsed.scheme, parsed.netloc, path, "", "", ""))
    except Exception:
        return ""


def _normalize_ws_url_list(raw: Any) -> list[str]:
    """归一化 URL 列表，兼容字符串、列表与逗号分隔形式。"""
    values: list[str] = []
    if isinstance(raw, str):
        values = [v.strip() for v in raw.replace("\n", ",").split(",")]
    elif isinstance(raw, list):
        values = [v for v in raw if isinstance(v, str)]
    else:
        return []

    result: list[str] = []
    for value in values:
        normalized = _normalize_ws_url(value)
        if normalized and normalized not in result:
            result.append(normalized)
    return result


def _extract_connection_info(
    data: dict[str, Any],
) -> tuple[str, list[str], list[dict[str, Any]]]:
    """提取连接 URL 列表与 ICE 配置，缺失时使用配置和默认值。"""
    url_paths = [
        ("url",),
        ("livekitUrl",),
        ("livekit_url",),
        ("livekitServerUrl",),
        ("ws_url",),
        ("serverUrl",),
        ("livekit", "url"),
        ("livekit", "ws_url"),
        ("connection", "url"),
        ("connectionDetails", "url"),
        ("connection_details", "url"),
    ]
    upstream_primary = _normalize_ws_url(_first_string(data, url_paths))

    url_list_paths = [
        ("urls",),
        ("livekitUrls",),
        ("livekit_urls",),
        ("connection", "urls"),
        ("connectionDetails", "urls"),
        ("connection_details", "urls"),
    ]
    upstream_urls: list[str] = []
    for path in url_list_paths:
        upstream_urls = _normalize_ws_url_list(_deep_get(data, path))
        if upstream_urls:
            break

    configured_primary = _normalize_ws_url(get_config("voice.livekit_url", ""))
    configured_urls = _normalize_ws_url_list(get_config("voice.livekit_urls", []))
    urls: list[str] = []
    for candidate in (
        [configured_primary] + configured_urls + [upstream_primary] + upstream_urls + [DEFAULT_LIVEKIT_URL]
    ):
        normalized = _normalize_ws_url(candidate)
        if normalized and normalized not in urls:
            urls.append(normalized)

    ice_paths = [
        ("iceServers",),
        ("ice_servers",),
        ("rtcConfig", "iceServers"),
        ("rtcConfig", "ice_servers"),
        ("rtc_config", "iceServers"),
        ("rtc_config", "ice_servers"),
        ("connectionDetails", "rtcConfig", "iceServers"),
        ("connectionDetails", "rtc_config", "ice_servers"),
        ("connection_details", "rtcConfig", "iceServers"),
    ]
    ice_servers: list[dict[str, Any]] = []
    for path in ice_paths:
        ice_servers = _normalize_ice_servers(_deep_get(data, path))
        if ice_servers:
            break

    return urls[0], urls, ice_servers


def _build_signal_proxy_url(request: Request) -> str:
    """生成前端可直连的同域信令代理地址。"""
    if not bool(get_config("voice.signal_proxy_enabled", True)):
        return ""

    configured = _normalize_ws_url(get_config("voice.signal_proxy_url", ""))
    if configured:
        return configured

    forwarded_host = request.headers.get("x-forwarded-host", "")
    host = (forwarded_host.split(",")[0].strip() if forwarded_host else "") or request.headers.get("host", "")
    if not host:
        return ""

    forwarded_proto = request.headers.get("x-forwarded-proto", "")
    proto = (forwarded_proto.split(",")[0].strip().lower() if forwarded_proto else "") or request.url.scheme.lower()
    ws_scheme = "wss" if proto == "https" else "ws"
    return f"{ws_scheme}://{host}/v1/public/voice/signal"


def _build_upstream_signal_url(websocket: WebSocket, tail: str) -> str:
    """把浏览器请求映射到上游 LiveKit 信令 URL。"""
    upstream_override = _normalize_ws_url(websocket.query_params.get("upstream"))
    configured_primary = _normalize_ws_url(get_config("voice.livekit_url", ""))
    configured_urls = _normalize_ws_url_list(get_config("voice.livekit_urls", []))
    base_url = upstream_override or configured_primary or (
        configured_urls[0] if configured_urls else DEFAULT_LIVEKIT_URL
    )

    parsed = urlparse(base_url)
    base_path = (parsed.path or "").rstrip("/")
    tail_clean = (tail or "").strip("/")
    if tail_clean:
        tail_path = f"/{tail_clean}"
        if base_path.endswith(tail_path):
            target_path = base_path
        elif base_path:
            target_path = f"{base_path}{tail_path}"
        else:
            target_path = tail_path
    else:
        target_path = base_path

    query_items = [(k, v) for k, v in websocket.query_params.multi_items() if k != "upstream"]
    query = urlencode(query_items, doseq=True)
    return urlunparse((parsed.scheme, parsed.netloc, target_path, "", query, ""))


def _mask_url(url: str) -> str:
    """仅保留协议与主机，避免记录敏感参数。"""
    try:
        from urllib.parse import urlparse

        parsed = urlparse(url)
        if parsed.scheme and parsed.netloc:
            return f"{parsed.scheme}://{parsed.netloc}{parsed.path or ''}"
    except Exception:
        pass
    return url


@router.get(
    "/voice/token",
    dependencies=[Depends(verify_public_key)],
    response_model=VoiceTokenResponse,
)
async def public_voice_token(
    request: Request,
    voice: str = "ara",
    personality: str = "assistant",
    speed: float = 1.0,
):
    """获取 Grok Voice Mode (LiveKit) Token"""
    token_mgr = await get_token_manager()
    sso_token = None
    for pool_name in ("ssoBasic", "ssoSuper"):
        sso_token = token_mgr.get_token(pool_name)
        if sso_token:
            break

    if not sso_token:
        raise AppException(
            "No available tokens for voice mode",
            code="no_token",
            status_code=503,
        )

    service = VoiceService()
    try:
        data = await service.get_token(
            token=sso_token,
            voice=voice,
            personality=personality,
            speed=speed,
        )
        token = data.get("token")
        if not token:
            raise AppException(
                "Upstream returned no voice token",
                code="upstream_error",
                status_code=502,
            )

        url, urls, ice_servers = _extract_connection_info(data)
        signal_proxy_url = _build_signal_proxy_url(request)
        participant_name = _first_string(
            data,
            [
                ("participant_name",),
                ("participantName",),
                ("identity",),
            ],
        )
        room_name = _first_string(
            data,
            [
                ("room_name",),
                ("roomName",),
                ("room",),
            ],
        )

        logger.info(
            "Voice token prepared: "
            f"url={_mask_url(url)}, urls={len(urls)}, ice_servers={len(ice_servers)}, "
            f"signal_proxy={'yes' if signal_proxy_url else 'no'}, "
            f"participant_name={'yes' if participant_name else 'no'}, "
            f"room_name={'yes' if room_name else 'no'}, token_len={len(token)}"
        )

        return VoiceTokenResponse(
            token=token,
            url=url,
            urls=urls,
            participant_name=participant_name,
            room_name=room_name,
            ice_servers=ice_servers or None,
            signal_proxy_url=signal_proxy_url or None,
        )

    except Exception as e:
        if isinstance(e, AppException):
            raise
        raise AppException(
            f"Voice token error: {str(e)}",
            code="voice_error",
            status_code=500,
        )


@router.websocket("/voice/signal")
@router.websocket("/voice/signal/{tail:path}")
async def public_voice_signal_proxy(websocket: WebSocket, tail: str = ""):
    """同域信令代理：用于移动端无法直连 livekit.grok.com 的场景。"""
    upstream_conn = None
    await websocket.accept()
    try:
        upstream_url = _build_upstream_signal_url(websocket, tail)
        ws_client = WebSocketClient()
        upstream_conn = await ws_client.connect(
            upstream_url,
            headers=build_ws_headers(origin="https://grok.com"),
            timeout=get_config("voice.timeout"),
        )
        upstream_ws = upstream_conn.ws
        logger.info(f"Voice signal proxy connected: {_mask_url(upstream_url)}")

        async def _client_to_upstream():
            while True:
                message = await websocket.receive()
                msg_type = message.get("type")
                if msg_type == "websocket.disconnect":
                    break
                if msg_type != "websocket.receive":
                    continue
                text_data = message.get("text")
                if text_data is not None:
                    await upstream_ws.send_str(text_data)
                    continue
                bytes_data = message.get("bytes")
                if bytes_data is not None:
                    await upstream_ws.send_bytes(bytes_data)

        async def _upstream_to_client():
            async for msg in upstream_ws:
                if msg.type == aiohttp.WSMsgType.TEXT:
                    await websocket.send_text(msg.data)
                elif msg.type == aiohttp.WSMsgType.BINARY:
                    await websocket.send_bytes(msg.data)
                elif msg.type in (
                    aiohttp.WSMsgType.CLOSE,
                    aiohttp.WSMsgType.CLOSED,
                    aiohttp.WSMsgType.ERROR,
                ):
                    break

        relay_tasks = [
            asyncio.create_task(_client_to_upstream()),
            asyncio.create_task(_upstream_to_client()),
        ]
        done, pending = await asyncio.wait(
            relay_tasks, return_when=asyncio.FIRST_COMPLETED
        )

        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)

        for task in done:
            exc = task.exception()
            if exc:
                raise exc

    except WebSocketDisconnect:
        logger.debug("Voice signal proxy: client disconnected")
    except Exception as e:
        logger.warning(f"Voice signal proxy error: {e}")
    finally:
        if upstream_conn:
            try:
                await upstream_conn.close()
            except Exception:
                pass
        try:
            from starlette.websockets import WebSocketState

            if websocket.client_state == WebSocketState.CONNECTED:
                await websocket.close(code=1000)
        except Exception:
            pass


@router.get("/verify", dependencies=[Depends(verify_public_key)])
async def public_verify_api():
    """验证 Public Key"""
    return {"status": "success"}
