import asyncio
import json
from pathlib import Path

import tornado
from jupyter_server.base.handlers import APIHandler
from jupyter_server.utils import url_path_join
from pydantic import BaseModel, ValidationError

from . import exporting, jobs, service
from .models import ExportRequest, GradeRequest, HardenRequest, KeyRequest, ModelsRequest, ProviderRequest, RunRequest
from .providers import (
    edit_models,
    providers_text,
    registry,
    remove_provider,
    reset_providers,
    save_provider,
    save_providers_text,
)


class BaseHandler(APIHandler):
    def parse(self, model: type[BaseModel]):
        try:
            return model.model_validate(self.get_json_body() or {})
        except ValidationError as e:
            raise tornado.web.HTTPError(400, reason=str(e)[:500])

    @property
    def root(self) -> Path:
        return Path(self.settings["server_root_dir"]).expanduser().resolve()

    def reply(self, data) -> None:
        self.finish(json.dumps(data, default=lambda o: o.model_dump() if isinstance(o, BaseModel) else str(o)))

    def fail(self, status: int, e: Exception) -> None:
        self.set_status(status)
        self.finish(json.dumps({"message": service.error_text(e)}))


class ConfigHandler(BaseHandler):
    @tornado.web.authenticated
    async def get(self):
        if not registry.providers:
            await registry.load()
        self.reply(registry.public_config())


class ReloadHandler(BaseHandler):
    @tornado.web.authenticated
    async def post(self):
        await registry.load()
        self.reply(registry.public_config())


class ConfigChangeHandler(BaseHandler):
    """Base for requests that change providers.json / .env and answer with the reloaded config."""

    async def change(self, action) -> None:
        try:
            result = action()
            if asyncio.iscoroutine(result):
                await result
        except ValueError as e:
            self.set_status(400)
            return self.finish(json.dumps({"message": str(e)}))
        await registry.load()
        self.reply(registry.public_config())


class KeyHandler(ConfigChangeHandler):
    """Set the API key of a provider (stored in ~/.aissignment/.env)."""

    @tornado.web.authenticated
    async def post(self):
        req = self.parse(KeyRequest)
        provider = registry.providers.get(req.provider)
        if provider is None:
            raise tornado.web.HTTPError(400, reason="Unknown provider")
        await self.change(lambda: save_provider(provider.id, provider.name, provider.base_url, req.value))


class ProviderHandler(ConfigChangeHandler):
    """Add (no id) or edit a provider. The connection is tested before saving."""

    @tornado.web.authenticated
    async def post(self):
        req = self.parse(ProviderRequest)
        await self.change(lambda: save_provider(req.id, req.name, req.base_url, req.api_key))


class RemoveProviderHandler(ConfigChangeHandler):
    @tornado.web.authenticated
    async def post(self):
        provider_id = str((self.get_json_body() or {}).get("id", ""))
        await self.change(lambda: remove_provider(provider_id))


class ModelsHandler(ConfigChangeHandler):
    """Add or remove a model in a provider's list."""

    @tornado.web.authenticated
    async def post(self):
        req = self.parse(ModelsRequest)
        await self.change(lambda: edit_models(req.provider, add=req.add, remove=req.remove))


class ProvidersFileHandler(ConfigChangeHandler):
    """Read / replace ~/.aissignment/providers.json (which models and endpoints are offered)."""

    @tornado.web.authenticated
    async def get(self):
        text, custom = providers_text()
        self.reply({"text": text, "custom": custom})

    @tornado.web.authenticated
    async def post(self):
        body = self.get_json_body() or {}
        if body.get("reset"):
            await self.change(reset_providers)
        else:
            await self.change(lambda: save_providers_text(str(body.get("text", ""))))


class RunHandler(BaseHandler):
    job_id: str | None = None

    @tornado.web.authenticated
    async def post(self):
        req = self.parse(RunRequest)
        self.job_id = req.job_id
        progress = jobs.Progress()
        try:
            self.reply({"results": await jobs.run(req.job_id, service.run(req, self.root), progress)})
        except asyncio.CancelledError:
            if (task := asyncio.current_task()) and task.cancelling():
                raise  # the server itself is shutting down
            self.reply({"cancelled": True, "cost": progress.cost})
        except KeyError as e:
            self.fail(400, e)

    def on_connection_close(self):
        # Page reloaded or closed: stop the run, nobody would see its results.
        if self.job_id:
            jobs.cancel(self.job_id)


class ProgressHandler(BaseHandler):
    """Progress of running jobs: ?ids=a,b -> {id: progress or null}."""

    @tornado.web.authenticated
    async def get(self):
        ids = [i for i in self.get_argument("ids", "").split(",") if i]
        self.reply(jobs.snapshot(ids))


class CancelHandler(BaseHandler):
    """Stop running jobs: {"ids": [...]}; they answer their run request with {"cancelled": true}."""

    @tornado.web.authenticated
    async def post(self):
        ids = (self.get_json_body() or {}).get("ids", [])
        self.reply({"cancelled": [i for i in ids if jobs.cancel(str(i))]})


class GradeHandler(BaseHandler):
    @tornado.web.authenticated
    async def post(self):
        self.reply({"answers": await service.regrade(self.parse(GradeRequest), self.root)})


class HardenHandler(BaseHandler):
    @tornado.web.authenticated
    async def post(self):
        try:
            self.reply(await service.harden(self.parse(HardenRequest)))
        except Exception as e:
            self.fail(502, e)


class ExportHandler(BaseHandler):
    @tornado.web.authenticated
    async def post(self):
        req = self.parse(ExportRequest)
        root = Path(self.settings["server_root_dir"]).expanduser().resolve()
        path = (root / req.path).resolve()
        if root not in path.parents or path.suffix != ".ipynb" or not path.exists():
            raise tornado.web.HTTPError(400, reason="Invalid notebook path")
        if req.check:
            existing = [p for p in exporting.export_targets(path) if p.exists()]
            return self.reply({"existing": [str(p.relative_to(root)) for p in existing]})
        try:
            # PDF rendering drives a headless browser; keep it off the server's event loop.
            files = await asyncio.get_running_loop().run_in_executor(None, exporting.export, path)
        except Exception as e:
            self.log.exception("Export failed")
            return self.fail(500, e)
        self.reply({"files": [str(Path(f).relative_to(root)) for f in files]})


def setup_route_handlers(web_app):
    base_url = web_app.settings["base_url"]
    routes = {
        "config": ConfigHandler,
        "config/reload": ReloadHandler,
        "config/key": KeyHandler,
        "config/provider": ProviderHandler,
        "config/provider/remove": RemoveProviderHandler,
        "config/models": ModelsHandler,
        "config/providers": ProvidersFileHandler,
        "run": RunHandler,
        "run/progress": ProgressHandler,
        "run/cancel": CancelHandler,
        "grade": GradeHandler,
        "harden": HardenHandler,
        "export": ExportHandler,
    }
    web_app.add_handlers(
        ".*$", [(url_path_join(base_url, "aissignment", path), handler) for path, handler in routes.items()]
    )
