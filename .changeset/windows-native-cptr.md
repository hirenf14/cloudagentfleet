---
"@cloudagentfleet/worker": minor
---

On Windows, `cloudagentfleet setup` runs Open WebUI Computer natively (it asks; WSL stays available) while Codeman keeps running in WSL, so cptr works with your Windows folders and tools. With both backends, `cloudagentfleet run` starts a WSL Worker for Codeman and a native `<id>-windows` Worker for cptr, and stops them together. Also on Windows:

- `cloudagentfleet worker install` no longer needs administrator rights. The task starts at your logon without a window, restarts failed Workers after 5 seconds, and logs to `%USERPROFILE%\.cloudagentfleet\worker.log`. Reinstall the service to pick this up.
- `cloudagentfleet worker stop` stops every Worker process (ending the task alone left them running), and a second start no longer runs duplicate Workers.
- Codeman and cptr start from your home folder, so they no longer keep the Worker's install folder in use.
- Running the Worker in WSL from Windows now passes its settings through (they were not exported, so the WSL Worker failed to start).
- Setup finds `cptr.exe` outside PATH, picks a free port for cptr, and cptr no longer crashes on start because of the console code page.
