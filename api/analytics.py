"""Global analytics tracker for request and token counts."""

import time
from dataclasses import dataclass


@dataclass
class AnalyticsData:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    requests_count: int = 0
    errors_count: int = 0
    start_time: float = time.time()


class GlobalAnalytics:
    """Singleton tracker for server-wide analytics."""

    _instance: AnalyticsData | None = None

    @classmethod
    def get_instance(cls) -> AnalyticsData:
        if cls._instance is None:
            cls._instance = AnalyticsData()
        return cls._instance
