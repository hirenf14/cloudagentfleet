---
"@cloudagentfleet/hub": minor
"@cloudagentfleet/ui": minor
"@cloudagentfleet/worker": minor
---

Introduce a host backend layer. Instances now carry a `backend` (currently `codeman`) and the features their adapter advertises; the Hub gates every backend action on those features (unsupported → HTTP 409) and adds `GET /api/backends`. The dashboard renders actions and labels from features and backends, and `cloudagentfleet enroll` accepts `--backend` (default `codeman`). Existing Hub state and Workers keep working unchanged.
