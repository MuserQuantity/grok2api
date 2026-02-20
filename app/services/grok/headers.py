"""
共用请求头构造 — 从配置动态生成 Client Hints
"""

import re
import uuid
from typing import Dict, Optional

from app.core.config import get_config
from app.services.grok.statsig import StatsigService


def _extract_major_version(browser: Optional[str], user_agent: Optional[str]) -> Optional[str]:
    if browser:
        match = re.search(r"(\d{2,3})", browser)
        if match:
            return match.group(1)
    if user_agent:
        for pattern in [r"Edg/(\d+)", r"Chrome/(\d+)", r"Chromium/(\d+)"]:
            match = re.search(pattern, user_agent)
            if match:
                return match.group(1)
    return None


def _detect_platform(user_agent: str) -> Optional[str]:
    ua = user_agent.lower()
    if "windows" in ua:
        return "Windows"
    if "mac os x" in ua or "macintosh" in ua:
        return "macOS"
    if "android" in ua:
        return "Android"
    if "iphone" in ua or "ipad" in ua:
        return "iOS"
    if "linux" in ua:
        return "Linux"
    return None


def _detect_arch(user_agent: str) -> Optional[str]:
    ua = user_agent.lower()
    if "aarch64" in ua or "arm" in ua:
        return "arm"
    if "x86_64" in ua or "x64" in ua or "win64" in ua or "intel" in ua:
        return "x86"
    return None


def build_client_hints(browser: Optional[str] = None, user_agent: Optional[str] = None) -> Dict[str, str]:
    """
    根据 browser 配置和 User-Agent 自动构造 Sec-Ch-Ua 系列 Client Hints。

    支持 Chrome/Chromium/Edge/Brave，非 Chromium 浏览器返回空字典。
    """
    browser = (browser or "").strip().lower()
    user_agent = user_agent or ""
    ua = user_agent.lower()

    is_edge = "edge" in browser or "edg" in ua
    is_brave = "brave" in browser
    is_chromium = any(key in browser for key in ["chrome", "chromium", "edge", "brave"]) or (
        "chrome" in ua or "chromium" in ua or "edg" in ua
    )

    if not is_chromium:
        return {}

    version = _extract_major_version(browser, user_agent)
    if not version:
        return {}

    if is_edge:
        brand = "Microsoft Edge"
    elif "chromium" in browser:
        brand = "Chromium"
    elif is_brave:
        brand = "Brave"
    else:
        brand = "Google Chrome"

    sec_ch_ua = (
        f'"{brand}";v="{version}", '
        f'"Chromium";v="{version}", '
        '"Not(A:Brand";v="24"'
    )

    platform = _detect_platform(user_agent)
    arch = _detect_arch(user_agent)
    mobile = "?1" if ("mobile" in ua or platform in ("Android", "iOS")) else "?0"

    hints: Dict[str, str] = {
        "Sec-Ch-Ua": sec_ch_ua,
        "Sec-Ch-Ua-Mobile": mobile,
    }
    if platform:
        hints["Sec-Ch-Ua-Platform"] = f'"{platform}"'
    if arch:
        hints["Sec-Ch-Ua-Arch"] = arch
        hints["Sec-Ch-Ua-Bitness"] = "64"
    hints["Sec-Ch-Ua-Model"] = ""
    return hints


def build_common_headers(token: str) -> Dict[str, str]:
    """
    构造通用 Grok API 请求头。

    从 config 中读取 browser / user_agent，动态生成 Client Hints。
    """
    browser_cfg = get_config("grok.browser", "chrome136")
    user_agent = get_config(
        "grok.user_agent",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    )

    headers: Dict[str, str] = {
        "Accept": "*/*",
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Baggage": "sentry-environment=production,sentry-release=d6add6fb0460641fd482d767a335ef72b9b6abb8,sentry-public_key=b311e0f2690c81f25e2c4cf6d4f7ce1c",
        "Cache-Control": "no-cache",
        "Content-Type": "application/json",
        "Origin": "https://grok.com",
        "Pragma": "no-cache",
        "Priority": "u=1, i",
        "Referer": "https://grok.com/",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "User-Agent": user_agent,
    }

    # 动态 Client Hints
    hints = build_client_hints(browser_cfg, user_agent)
    headers.update(hints)

    # Statsig / Request ID
    headers["x-statsig-id"] = StatsigService.gen_id()
    headers["x-xai-request-id"] = str(uuid.uuid4())

    # Cookie
    raw = token[4:] if token.startswith("sso=") else token
    cf = get_config("grok.cf_clearance", "")
    headers["Cookie"] = f"sso={raw};cf_clearance={cf}" if cf else f"sso={raw}"

    return headers


__all__ = ["build_common_headers", "build_client_hints"]
