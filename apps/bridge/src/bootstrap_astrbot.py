import os
import sys

os.environ.setdefault("ASTRBOT_ROOT", "/app")
sys.path.insert(0, "/app/AstrBot")

from astrbot.core.config.astrbot_config import AstrBotConfig  # noqa: E402


def upsert(items: list[dict], item: dict) -> None:
    for index, current in enumerate(items):
        if current.get("id") == item["id"]:
            items[index] = {**current, **item}
            return
    items.append(item)


config = AstrBotConfig()

platforms = config.setdefault("platform", [])
upsert(
    platforms,
    {
        "id": "wechat-onebot",
        "type": "aiocqhttp",
        "enable": True,
        "ws_reverse_host": "127.0.0.1",
        "ws_reverse_port": 6199,
        "ws_reverse_token": "",
    },
)

llm_enabled = os.getenv("LLM_ENABLED", "true").lower() in {"1", "true", "yes", "on"}
llm_api_key = os.getenv("LLM_API_KEY") or os.getenv("DEEPSEEK_API_KEY", "")
if llm_enabled and llm_api_key:
    provider_name = os.getenv("LLM_PROVIDER", "deepseek")
    api_base = os.getenv(
        "LLM_API_BASE",
        os.getenv("DEEPSEEK_API_BASE", "https://api.deepseek.com/v1"),
    )
    model = os.getenv("LLM_MODEL", os.getenv("DEEPSEEK_MODEL", "deepseek-v4-flash"))
    max_context_tokens = int(os.getenv("LLM_MAX_CONTEXT_TOKENS", "131072"))
    key_reference = "$LLM_API_KEY" if os.getenv("LLM_API_KEY") else "$DEEPSEEK_API_KEY"

    provider_sources = config.setdefault("provider_sources", [])
    upsert(
        provider_sources,
        {
            "id": "feagle-llm-source",
            "provider": provider_name,
            "type": "openai_chat_completion",
            "provider_type": "chat_completion",
            "enable": True,
            "key": [key_reference],
            "api_base": api_base,
            "timeout": 120,
            "proxy": "",
            "custom_headers": {},
        },
    )

    providers = config.setdefault("provider", [])
    upsert(
        providers,
        {
            "id": "feagle-llm-model",
            "provider_source_id": "feagle-llm-source",
            "model": model,
            "modalities": ["text"],
            "custom_extra_body": {},
            "max_context_tokens": max_context_tokens,
            "enable": True,
        },
    )

    provider_settings = config.setdefault("provider_settings", {})
    provider_settings["enable"] = True
    provider_settings["default_provider_id"] = "feagle-llm-model"

dashboard = config.setdefault("dashboard", {})
dashboard["enable"] = True
dashboard["host"] = "0.0.0.0"
dashboard["port"] = 6185

config.save_config(indent=4)
