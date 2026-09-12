# Kestrel Bio Public API Documentation

The public API exposes read-only compound metadata to registered collaborators.
Authenticate with a bearer token issued from your account settings. All endpoints
are versioned under /v1 and return JSON.

GET /v1/compounds/{id} returns public identity fields for a compound: registry
identifier, molecular formula and publication references. Assay results are not
exposed through this endpoint.

Rate limits are 120 requests per minute per token. Exceeding the limit returns
429 with a Retry-After header.

This documentation is published on our website and may be shared freely.
