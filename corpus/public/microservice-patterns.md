# Common Microservice Patterns

Service-to-service authentication in a zero-trust network is typically handled
with mutual TLS and short-lived certificates issued by an internal certificate
authority, rather than long-lived shared secrets.

Event-driven pipelines commonly place a message broker such as Kafka between
ingestion and processing so that downstream consumers can be scaled or replayed
independently. Carrying a correlation identifier through every hop is standard
practice for tracing a record back to its source.

A single API gateway that terminates authentication at the edge keeps authorisation
logic out of individual services. Designating one service as the system of record
for a given entity prevents write conflicts across a distributed system.
