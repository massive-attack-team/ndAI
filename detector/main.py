"""ndAI local inspection service.

Binds to 127.0.0.1 only. The prompt text never leaves this process except as a
rewritten version the user has seen and approved.
"""
from __future__ import annotations

import logging

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import audit, calibration, config, context, pipeline, policy, rewrite
from sanitiser.service import reapply as sanitiser_reapply
from sanitiser.service import sanitise as sanitiser_sanitise

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger("ndai")

app = FastAPI(title="ndAI", version="0.1.0")

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


class SanitiseRequest(BaseModel):
    text: str


class ReapplyRequest(BaseModel):
    original_text: str
    edits: list[dict]


class LocalAnswerRequest(BaseModel):
    text: str


@app.on_event("startup")
def startup() -> None:
    audit.init()
    context.init()
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


@app.get("/graph")
def graph():
    return context.graph(teams=policy.get_engine().teams)


@app.post("/policy/reload")
def reload_policy():
    policy.get_engine().reload()
    return {"reloaded": True}


@app.post("/sanitise")
def sanitise_endpoint(req: SanitiseRequest):
    """Standalone sanitiser call for the diff UI - runs detection itself.
    /inspect is the source of truth for the allow/warn/sanitize/block
    decision; this exists so the UI can re-run just the rewrite+verify step
    (e.g. after the user edits the prompt) without a full /inspect round trip."""
    return sanitiser_sanitise(req.text).to_json()


@app.post("/sanitise/reapply")
def reapply_endpoint(req: ReapplyRequest):
    """UI toggled accept/reject on some spans - recompute without re-running
    the model."""
    return {"sanitised_text": sanitiser_reapply(req.original_text, req.edits)}


@app.post("/local-answer")
def local_answer(req: LocalAnswerRequest):
    """Block path: the original prompt never leaves the machine."""
    return {"answer": rewrite.answer_locally(req.text)}


@app.post("/inspect/file")
async def inspect_file_endpoint(
    file: UploadFile = File(...),
    destination: str = Form(...),
    user: str = Form("unknown"),
    role: str = Form("default"),
):
    """Same judgment as /inspect, applied per row/page of an uploaded
    document (csv/md/txt/pdf/xlsx/parquet - detector/ingest.py)."""
    data = await file.read()
    result = pipeline.inspect_file(file.filename, data, destination=destination, user=user, role=role)
    return result.__dict__


@app.get("/calibration")
def calibration_endpoint():
    """Current team-history stats and the effective (calibrated)
    provenance margin per in-scope document type - lets you see exactly
    why a threshold moved, matching policy.yaml's "deliberately dumb,
    auditable" ethos."""
    return calibration.calibration_report()


@app.get("/users/{user}/profile")
def user_profile_endpoint(user: str):
    """Advisory only: what this user's own history looks like by document
    type. Never fed into policy.py's role-based clearance."""
    return calibration.user_profile(user)


def run() -> None:
    import uvicorn

    uvicorn.run(app, host=config.HOST, port=config.PORT, log_level="info")


if __name__ == "__main__":
    run()
