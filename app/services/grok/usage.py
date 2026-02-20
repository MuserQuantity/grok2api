"""
Grok 用量服务
"""

import asyncio
import uuid
from typing import Dict

import orjson
from curl_cffi.requests import AsyncSession

from app.core.logger import logger
from app.core.config import get_config
from app.core.exceptions import UpstreamException, AppException
from app.services.grok.statsig import StatsigService
from app.services.grok.retry import retry_on_status
from app.services.grok.headers import build_common_headers


LIMITS_API = "https://grok.com/rest/rate-limits"
BROWSER = "chrome136"
TIMEOUT = 10
DEFAULT_MAX_CONCURRENT = 25
_USAGE_SEMAPHORE = asyncio.Semaphore(DEFAULT_MAX_CONCURRENT)
_USAGE_SEM_VALUE = DEFAULT_MAX_CONCURRENT

def _get_usage_semaphore() -> asyncio.Semaphore:
    global _USAGE_SEMAPHORE, _USAGE_SEM_VALUE
    value = get_config("performance.usage_max_concurrent", DEFAULT_MAX_CONCURRENT)
    try:
        value = int(value)
    except Exception:
        value = DEFAULT_MAX_CONCURRENT
    value = max(1, value)
    if value != _USAGE_SEM_VALUE:
        _USAGE_SEM_VALUE = value
        _USAGE_SEMAPHORE = asyncio.Semaphore(value)
    return _USAGE_SEMAPHORE


class UsageService:
    """用量查询服务"""
    
    def __init__(self, proxy: str = None):
        self.proxy = proxy or get_config("grok.base_proxy_url", "")
        self.timeout = get_config("grok.timeout", TIMEOUT)
    
    def _build_headers(self, token: str) -> dict:
        """构建请求头"""
        return build_common_headers(token)
    
    def _build_proxies(self) -> dict:
        """构建代理配置"""
        return {"http": self.proxy, "https": self.proxy} if self.proxy else None
    
    async def get(self, token: str, model_name: str = "grok-4-1-thinking-1129") -> Dict:
        """
        获取速率限制信息
        
        Args:
            token: 认证 Token
            model_name: 模型名称
            
        Returns:
            响应数据
            
        Raises:
            UpstreamException: 当获取失败且重试耗尽时
        """
        async with _get_usage_semaphore():
            # 定义状态码提取器
            def extract_status(e: Exception) -> int | None:
                if isinstance(e, UpstreamException) and e.details:
                    return e.details.get("status")
                return None
            
            # 定义实际的请求函数
            async def do_request():
                try:
                    headers = self._build_headers(token)
                    payload = {
                        "requestKind": "DEFAULT",
                        "modelName": model_name
                    }
                    
                    async with AsyncSession() as session:
                        response = await session.post(
                            LIMITS_API,
                            headers=headers,
                            json=payload,
                            impersonate=BROWSER,
                            timeout=self.timeout,
                            proxies=self._build_proxies()
                        )
                    
                    if response.status_code == 200:
                        data = response.json()
                        remaining = data.get('remainingTokens', 0)
                        logger.info(f"Usage: quota {remaining} remaining")
                        return data
                    
                    logger.error(f"Usage failed: {response.status_code}")

                    raise UpstreamException(
                        message=f"Failed to get usage stats: {response.status_code}",
                        details={"status": response.status_code}
                    )
                    
                except Exception as e:
                    if isinstance(e, UpstreamException):
                        raise
                    logger.error(f"Usage error: {e}")
                    raise UpstreamException(
                        message=f"Usage service error: {str(e)}",
                        details={"error": str(e)}
                    )
            
            # 带重试的执行
            try:
                result = await retry_on_status(
                    do_request,
                    extract_status=extract_status
                )
                return result
                
            except Exception as e:
                # 最后一次失败已经被记录
                raise


__all__ = ["UsageService"]
