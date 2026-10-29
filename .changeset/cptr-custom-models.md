---
"@cloudagentfleet/worker": patch
"@cloudagentfleet/hub": patch
---

Add your own and local models to Open WebUI Computer. `~/.cloudagentfleet/cptr-models.json` can add model ids to any agent and list local model servers (Ollama, LM Studio, llama.cpp, vLLM) as connections. A server without a model list is asked again every few minutes, so a model you pull or remove shows up without a restart. Codex and Cursor models are still read from the agents themselves.
