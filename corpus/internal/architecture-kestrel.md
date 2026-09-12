# Kestrel Platform - Internal Architecture (CONFIDENTIAL)

Kestrel is the assay pipeline that ingests plate reader output, normalises it
against control wells, and writes dose-response curves to the compound registry.

## Services
- `kestrel-ingest` consumes raw plate files from the instrument share and emits
  one normalised record per well to the `plate.normalised` topic.
- `kestrel-curve` fits four-parameter logistic curves and rejects any plate whose
  Z-factor falls below 0.5. Rejected plates are quarantined, never deleted.
- `compound-registry` is the system of record for compound identity. It is the
  only service permitted to write to the `compounds` schema in Postgres.
- `kestrel-api` is the single external entry point and terminates all auth.

## Data flow
Instrument share to ingest, then Kafka, then curve fitting, then the registry,
then reporting. Every hop carries the plate barcode so a result can be traced
back to the physical plate that produced it.

## Authentication
Services authenticate to each other with short-lived mTLS certificates issued by
the internal CA. There is no shared service password. The registry additionally
checks a per-caller scope claim before allowing any write to compound identity.

## Known weaknesses
The ingest service trusts filenames from the instrument share to derive the plate
barcode. A malformed filename silently attaches results to the wrong compound.
This is tracked as KES-411 and is the single largest data integrity risk we have.
