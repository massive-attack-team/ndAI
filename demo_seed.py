"""Populate the audit log so the dashboard has something to show.

Run once before the demo:  python demo_seed.py
"""
from __future__ import annotations

from detector import audit, pipeline

SCENARIOS = [
    ("What is a Z-factor and why is 0.5 the usual cutoff for a screening assay?",
     "chatgpt.com", "priya@kestrelbio.com", "researcher"),
    ("Our screening platform takes readings off the plate reader, corrects them against the "
     "control wells, and stores the fitted curves in the compound database. Can you explain "
     "that architecture to a new starter?",
     "chatgpt.com", "sam@kestrelbio.com", "engineer"),
    ("Our lead molecule shrank tumours by a bit under half compared with vehicle in the second "
     "group, but we see liver problems past twelve milligrams per kilo. Help me write the "
     "results section.",
     "chatgpt.com", "priya@kestrelbio.com", "researcher"),
    ("Here is my env file, why does the connection fail: "
     "DATABASE_URL=postgresql://kestrel:8fh39dkw0slq@db.internal:5432/compounds",
     "claude.ai", "sam@kestrelbio.com", "engineer"),
    ("We are thinking about buying a microfluidics company for just under four hundred million, "
     "mostly cash with some stock. What should the board be asking?",
     "gemini.google.com", "dana@kestrelbio.com", "default"),
    ("Is mutual TLS with short lived certificates from an internal CA a reasonable service to "
     "service auth pattern for a small platform team?",
     "chatgpt.com", "sam@kestrelbio.com", "engineer"),
    ("The ingest service derives the plate barcode from the filename, so a malformed name files "
     "results under the wrong compound. How should I redesign it?",
     "localhost", "sam@kestrelbio.com", "engineer"),
]


def main() -> None:
    audit.init()
    state = pipeline.warm_up()
    print(f"backend={state['embed_backend']} semantic={state['semantic']} "
          f"rewrite={state['rewrite_model_up']}\n")
    for text, dest, user, role in SCENARIOS:
        r = pipeline.inspect(text, destination=dest, user=user, role=role)
        print(f"{r.action:9s} {dest:22s} {r.latency_ms:6.1f}ms  {r.rule}")
        print(f"          {r.baselines['ndai']}")
    print("\n" + str(audit.stats()))


if __name__ == "__main__":
    main()
