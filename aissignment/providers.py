"""OpenAI-compatible providers (OpenRouter, university-hosted endpoints, ...) configured in providers.json."""

import asyncio
import json
import logging
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

import httpx
from dotenv import dotenv_values
from openai import AsyncOpenAI
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from . import jobs

log = logging.getLogger(__name__)

# User configuration lives outside the package so it survives updates:
#   ~/.aissignment/.env             API keys (OPENROUTER_API_KEY, AISS_<PROVIDER>_API_KEY, ...)
#   ~/.aissignment/providers.json   optional; overrides the packaged default_providers.json
CONFIG_DIR = Path(os.getenv("AISSIGNMENT_CONFIG_DIR", Path.home() / ".aissignment"))
ENV_PATH = CONFIG_DIR / ".env"
DEFAULT_CONFIG_PATH = Path(__file__).with_name("default_providers.json")


def config_path() -> Path:
    return Path(os.getenv("AISSIGNMENT_PROVIDERS", CONFIG_DIR / "providers.json"))


def read_env() -> dict[str, str]:
    """Process environment, overridden by ~/.aissignment/.env (re-read on every reload)."""
    values = dict(os.environ)
    if ENV_PATH.exists():
        values.update({k: v for k, v in dotenv_values(ENV_PATH).items() if v is not None})
    return values


def set_env_value(key: str, value: str | None) -> None:
    """Write/replace one KEY=value line in ~/.aissignment/.env (None removes it)."""
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    lines = ENV_PATH.read_text().splitlines() if ENV_PATH.exists() else []
    lines = [line for line in lines if not line.strip().startswith(f"{key}=")]
    if value is not None:
        lines.append(f"{key}={value}")
    ENV_PATH.write_text("\n".join(lines) + "\n")
    ENV_PATH.chmod(0o600)


# --- providers.json (editable from the sidebar's advanced settings) ---------------------------------


class ModelSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1)
    label: str | None = None


class ProviderSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, pattern=r"^[^:\s]+$")
    name: str | None = None
    base_url: str | None = None
    base_url_env: str | None = None
    api_key_env: str | None = None
    api_key: str | None = None
    models: list[str | ModelSpec] = []

    @field_validator("base_url_env", "api_key_env")
    @classmethod
    def env_name(cls, value: str | None, info) -> str | None:
        if value and not value.replace("_", "").isalnum():
            direct = "base_url" if info.field_name == "base_url_env" else "api_key"
            raise ValueError(
                f"must be the NAME of a variable in .env (like MY_BASE_URL), not the value itself. "
                f'To enter the value directly, use "{direct}" instead.'
            )
        return value


class Defaults(BaseModel):
    model_config = ConfigDict(extra="forbid")
    students: list[str] = []
    grader: str | None = None


class ProvidersFile(BaseModel):
    model_config = ConfigDict(extra="forbid")
    providers: list[ProviderSpec]
    defaults: Defaults = Defaults()

    @field_validator("providers")
    @classmethod
    def unique_ids(cls, providers: list[ProviderSpec]) -> list[ProviderSpec]:
        ids = [p.id for p in providers]
        if dupes := {i for i in ids if ids.count(i) > 1}:
            raise ValueError(f"duplicate provider id(s): {', '.join(sorted(dupes))}")
        return providers


def providers_text() -> tuple[str, bool]:
    """The providers.json in effect, and whether it is the user's own copy."""
    custom = config_path().exists()
    return (config_path() if custom else DEFAULT_CONFIG_PATH).read_text(), custom


def save_providers_text(text: str) -> None:
    """Validate and write the user's providers.json. Raises ValueError with a readable message."""
    try:
        ProvidersFile.model_validate(json.loads(text))
    except json.JSONDecodeError as e:
        raise ValueError(f"Invalid JSON: {e}") from None
    except ValidationError as e:
        problems = "; ".join(f"{'.'.join(map(str, err['loc']))}: {err['msg']}" for err in e.errors())
        raise ValueError(f"Invalid providers file: {problems}") from None
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text if text.endswith("\n") else text + "\n")


def reset_providers() -> None:
    config_path().unlink(missing_ok=True)


def _read_file() -> dict:
    return json.loads(providers_text()[0])


def _write_file(config: dict) -> None:
    save_providers_text(json.dumps(config, indent=2))


def builtin_ids() -> set[str]:
    return {p["id"] for p in json.loads(DEFAULT_CONFIG_PATH.read_text())["providers"]}


async def fetch_models(base_url: str, api_key: str | None) -> list[dict]:
    """GET <base_url>/models. Raises ValueError with a message meant for the sidebar."""
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    try:
        async with httpx.AsyncClient(timeout=15) as http:
            r = await http.get(base_url.rstrip("/") + "/models", headers=headers)
    except httpx.HTTPError as e:
        raise ValueError(f"Could not reach {base_url}: {e.__class__.__name__}") from None
    if r.status_code in (401, 403):
        raise ValueError("The endpoint rejected the API key.")
    if r.status_code == 404:
        raise ValueError(f"{base_url}/models not found. Is this the OpenAI-compatible base URL (often ending in /v1)?")
    if r.status_code >= 400:
        raise ValueError(f"The endpoint answered with HTTP {r.status_code}.")
    try:
        return [m for m in r.json().get("data", []) if m.get("id")]
    except (ValueError, AttributeError):
        raise ValueError("The endpoint did not return an OpenAI-style model list.") from None


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_") or "provider"


async def save_provider(provider_id: str | None, name: str, base_url: str, api_key: str) -> None:
    """Add a provider (provider_id None) or edit one. An empty api_key keeps the stored key.
    The connection is tested before anything is written."""
    config = _read_file()
    providers = config["providers"]
    existing = next((p for p in providers if p["id"] == provider_id), None)
    if provider_id and existing is None:
        raise ValueError(f"Unknown provider '{provider_id}'")
    builtin = provider_id in builtin_ids()
    name, base_url, api_key = name.strip(), base_url.strip().rstrip("/"), api_key.strip()
    if builtin:  # name and URL of built-in providers are fixed
        name, base_url = existing["name"], existing["base_url"]
    if not name:
        raise ValueError("Please enter a name.")
    if not re.match(r"^https?://\S+$", base_url):
        raise ValueError("The base URL must start with http:// or https://")

    if existing is None:
        ids = {p["id"] for p in providers}
        provider_id, n = _slug(name), 2
        while provider_id in ids:
            provider_id, n = f"{_slug(name)}_{n}", n + 1
        existing = {"id": provider_id, "name": name, "base_url": base_url, "api_key_env": "", "models": []}
        providers.append(existing)
    env_name = existing.get("api_key_env") or f"AISS_{provider_id.upper()}_API_KEY"
    key = api_key or read_env().get(env_name) or existing.get("api_key")
    if not key:
        raise ValueError("Please enter the API key.")
    await fetch_models(base_url, key)

    existing.update(name=name, base_url=base_url, api_key_env=env_name)
    existing.pop("base_url_env", None)
    existing.pop("api_key", None)
    _write_file(config)
    if api_key:
        set_env_value(env_name, api_key)


def remove_provider(provider_id: str) -> None:
    if provider_id in builtin_ids():
        raise ValueError("Built-in providers cannot be removed.")
    config = _read_file()
    provider = next((p for p in config["providers"] if p["id"] == provider_id), None)
    if provider is None:
        raise ValueError(f"Unknown provider '{provider_id}'")
    config["providers"].remove(provider)
    _write_file(config)
    if provider.get("api_key_env"):
        set_env_value(provider["api_key_env"], None)


def edit_models(provider_id: str, add: str | None = None, remove: str | None = None) -> None:
    config = _read_file()
    provider = next((p for p in config["providers"] if p["id"] == provider_id), None)
    if provider is None:
        raise ValueError(f"Unknown provider '{provider_id}'")
    models = provider.setdefault("models", [])
    model_id = lambda m: m["id"] if isinstance(m, dict) else m  # noqa: E731
    if add and add.strip() and add.strip() not in map(model_id, models):
        models.append(add.strip())
    if remove:
        provider["models"] = [m for m in models if model_id(m) != remove]
    _write_file(config)


# Limit parallel requests so a "5 models x 3 runs x 20 cells" run does not hammer the providers.
_semaphore = asyncio.Semaphore(8)


@dataclass
class Pricing:
    prompt: float = 0  # USD per token
    completion: float = 0


@dataclass
class Provider:
    id: str
    name: str
    base_url: str
    api_key: str | None
    models: list[str]
    api_key_env: str = ""
    labels: dict[str, str] = field(default_factory=dict)
    pricing: dict[str, Pricing] = field(default_factory=dict)
    catalog: list[str] = field(default_factory=list)  # all models the endpoint offers
    error: str | None = None
    _client: AsyncOpenAI | None = None

    @property
    def available(self) -> bool:
        return bool(self.base_url and self.api_key) and self.error is None

    @property
    def client(self) -> AsyncOpenAI:
        if self._client is None:
            self._client = AsyncOpenAI(base_url=self.base_url, api_key=self.api_key, timeout=300, max_retries=2)
        return self._client


class Registry:
    def __init__(self) -> None:
        self.providers: dict[str, Provider] = {}
        self.defaults: dict = {}

    async def load(self) -> None:
        path = config_path() if config_path().exists() else DEFAULT_CONFIG_PATH
        config = json.loads(path.read_text())
        env = read_env()
        self.defaults = config.get("defaults", {})
        self.providers = {}
        for p in config.get("providers", []):
            base_url = p.get("base_url") or env.get(p.get("base_url_env", ""), "")
            api_key = env.get(p.get("api_key_env", ""), "") or p.get("api_key") or None
            models = p.get("models", [])
            provider = Provider(
                id=p["id"],
                name=p.get("name", p["id"]),
                base_url=base_url,
                api_key=api_key,
                models=[m["id"] if isinstance(m, dict) else m for m in models],
                api_key_env=p.get("api_key_env", ""),
                labels={m["id"]: m["label"] for m in models if isinstance(m, dict) and "label" in m},
            )
            if not base_url:
                provider.error = (
                    f"No base URL: set {p['base_url_env']} in .env"
                    if p.get("base_url_env")
                    else 'No base URL: add "base_url" in providers.json'
                )
            elif not api_key:
                provider.error = "No API key yet"
            self.providers[provider.id] = provider

        await asyncio.gather(*(self._enrich(p) for p in self.providers.values() if p.base_url))

    async def _enrich(self, provider: Provider) -> None:
        """Fetch the endpoint's model list: names, pricing (OpenRouter publishes it), suggestions."""
        try:
            data = await fetch_models(provider.base_url, provider.api_key)
        except ValueError as e:  # pricing is nice-to-have; a wrong key shows up as a provider error
            log.warning("Could not fetch models from %s: %s", provider.name, e)
            if provider.api_key and "rejected" in str(e):
                provider.error = str(e)
            return
        by_id = {m["id"]: m for m in data}
        provider.catalog = sorted(by_id)
        for model_id in provider.models:
            m = by_id.get(model_id)
            if not m:
                continue
            if "name" in m and model_id not in provider.labels:
                provider.labels[model_id] = m["name"]
            pricing = m.get("pricing") or {}
            try:
                provider.pricing[model_id] = Pricing(float(pricing.get("prompt", 0)), float(pricing.get("completion", 0)))
            except (TypeError, ValueError):
                pass

    def resolve(self, model_key: str) -> tuple[Provider, str]:
        provider_id, _, model_id = model_key.partition(":")
        provider = self.providers.get(provider_id)
        if provider is None:
            raise ValueError(f"Unknown provider '{provider_id}'")
        if not provider.available:
            raise ValueError(f"Provider '{provider.name}' unavailable: {provider.error}")
        return provider, model_id

    def public_config(self) -> dict:
        builtin = builtin_ids()
        return {
            "env_path": str(ENV_PATH),
            "providers_path": str(config_path()),
            "custom_providers": config_path().exists(),
            "providers": [
                {
                    "id": p.id,
                    "name": p.name,
                    "api_key_env": p.api_key_env,
                    "base_url": p.base_url,
                    "builtin": p.id in builtin,
                    "key_set": bool(p.api_key),
                    "available": p.available,
                    "error": p.error,
                    "catalog": p.catalog,
                    "models": [
                        {
                            "key": f"{p.id}:{m}",
                            "id": m,
                            "label": p.labels.get(m, m),
                            "pricing": vars(p.pricing[m]) if m in p.pricing else None,
                        }
                        for m in p.models
                    ],
                }
                for p in self.providers.values()
            ],
            "defaults": self.defaults,
        }


registry = Registry()


@dataclass
class Completion:
    text: str
    cost: float


@dataclass
class Reply:
    message: dict  # the assistant message as the API returned it (content, tool_calls, reasoning, ...)
    cost: float


async def chat(model_key: str, messages: list[dict], **kwargs) -> Reply:
    provider, model_id = registry.resolve(model_key)
    async with _semaphore:
        response = await provider.client.chat.completions.create(model=model_id, messages=messages, **kwargs)
    message = response.choices[0].message.model_dump(exclude_none=True) if response.choices else {}
    cost = 0.0
    if response.usage and (pricing := provider.pricing.get(model_id)):
        cost = response.usage.prompt_tokens * pricing.prompt + response.usage.completion_tokens * pricing.completion
    jobs.add_cost(cost)
    return Reply(message=message, cost=cost)


async def complete(model_key: str, messages: list[dict], **kwargs) -> Completion:
    reply = await chat(model_key, messages, **kwargs)
    return Completion(text=(reply.message.get("content") or "").strip(), cost=reply.cost)
