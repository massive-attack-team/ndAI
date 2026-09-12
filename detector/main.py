"""NDAi local inspection service.

Binds to 127.0.0.1 only. The prompt text never leaves this process except as a
rewritten version the user has seen and approved.
"""
from __future__ import annotations

import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import audit, config, pipeline, policy

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger("ndai")

app = FastAPI(title="NDAi", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173", "http://127.0.0.1:5173",
        "https://chatgpt.com", "https://claude.ai", "https://gemini.google.com",
    ],
    allow_origin_regex=r"^chrome-extension://.*$",
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


class InspectRequest(BaseModel):
    text: str
    destination: str = Field(description="Hostname the text is headed to")
    user: str = "unknown"
    role: str = "default"
    log: bool = True


@app.on_event("startup")
def startup() -> None:
    audit.init()
    state = pipeline.warm_up()
    log.info("ready: %s", state)
    if not state["semantic"]:
        log.warning("Running on the hashing fallback. Paraphrase detection is off.")


@app.get("/health")
def health():
    return pipeline.warm_up()


@app.post("/inspect")
def inspect(req: InspectRequest):
    result = pipeline.inspect(
        req.text, destination=req.destination, user=req.user,
        role=req.role, log_event=req.log,
    )
    return result.__dict__


@app.get("/events")
def events(limit: int = 100):
    return audit.recent(limit)


@app.get("/stats")
def stats():
    return audit.stats()


@app.post("/policy/reload")
def reload_policy():
    policy.get_engine().reload()
    return {"reloaded": True}


def run() -> None:
    import uvicorn

    uvicorn.run(app, host=config.HOST, port=config.PORT, log_level="info")


if __name__ == "__main__":
    run()
