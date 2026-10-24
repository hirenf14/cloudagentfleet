---
"@cloudagentfleet/hub": minor
"@cloudagentfleet/worker": minor
---

Jobs now return the agent's answer: `GET /api/jobs/:id` includes `result` (or `error`), the Codeman `sessionId` and `finishedAt`. A new job can pass an earlier job's `sessionId` to continue the same conversation; the Worker only accepts sessions it created for jobs.
