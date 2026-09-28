# Codeman Federation Refactor

## Decision

Hosted Agents extends Codeman rather than replacing it.

Codeman remains the execution authority on each machine. It owns provider
processes, PTYs, tmux persistence, terminal bytes, session lifecycle, and
Codeman's native terminal behavior. Hosted Agents adds the federation layer
around those instances.

```text
Browser
  -> Unified Hub UI
     -> Controller federation and policy layer
        -> Worker connector
           -> Codeman instance
              -> PTY / tmux / Cursor / Claude
```

## Responsibilities

### Codeman

- Create and persist agent sessions.
- Own PTY input/output and terminal protocol handling.
- Start and stop configured providers.
- Expose the supported session, terminal, resize, and event APIs.

### Hosted Agents Controller

- Register and health-check many Codeman instances.
- Route each request by instance and namespaced session ID.
- Enforce workspace and provider readiness before session creation.
- Persist fleet metadata, audit events, and session indexes.
- Provide one authenticated Hub URL.

### Hosted Agents Worker

- Maintain an outbound connection to the Controller.
- Enforce local workspace policy.
- Forward approved operations to the local Codeman instance.
- Report local workspace and provider readiness.
- Never expose a new inbound terminal service.

### Unified UI

- Present hosts, workspaces, providers, and sessions in one navigation model.
- Render Codeman's terminal stream without reimplementing terminal semantics.
- Send keyboard data and resize events through the canonical transport.
- Keep host/session selection isolated and clearly visible.

## Refactor requirements

1. Define one canonical session transport contract for direct and connector
   adapters.
2. Preserve raw terminal bytes and terminal control sequences end to end.
3. Do not add CR/LF conversion, mux selection, or device-response filtering in
   more than one layer.
4. Add event IDs or replay cursors so reconnects cannot silently lose or
   duplicate output.
5. Bound persisted terminal history and make resync explicit.
6. Keep every session addressable as `instanceId/sessionId`.
7. Keep provider credentials and login inside Codeman/Worker machines.
8. Keep the UI usable when a Worker is offline or a provider is unauthenticated.
9. Keep the current HTTP API as a compatibility adapter while the canonical
   transport is introduced.
10. Prefer upstream Codeman extension points. Maintain a small fork only when
    a required supported hook cannot be added externally.

## Delivery phases

### Phase 1: Transport contract

- Define event sequencing, replay, input mode, resize acknowledgement, and
  session ownership in `packages/protocol`.
- Add contract tests for raw input, control keys, output ordering, and resync.

### Phase 2: Adapter consolidation

- Make the direct HTTP adapter and Worker connector implement the same
  transport behavior.
- Move Codeman compatibility quirks into the Codeman boundary.
- Remove duplicate normalization from the dashboard and Controller.

### Phase 3: Hub streaming

- Make the Hub event stream authoritative.
- Add reconnect/resync behavior and bounded terminal history.
- Keep polling only as health and metadata recovery.

### Phase 4: UI federation

- Keep the host/workspace/session navigation.
- Render the canonical Codeman stream in the terminal panel.
- Add browser regression coverage for input, Enter/Ctrl-C, session switching,
  scrolling, and ANSI/TUI output.

### Phase 5: Fork decision and release

- Compare the required hooks with the current upstream Codeman API.
- Fork only the smallest missing surface, if necessary.
- Rebuild the Worker installer and verify a two-host connector cycle.

## Acceptance criteria

- Starting a session follows host -> workspace -> provider -> session.
- A session created on one host never appears under another host.
- Printable input, Enter, Ctrl-C, arrows, and provider TUI sequences reach the
  same Codeman session without corruption.
- Reconnecting the browser resumes output without duplication or loss.
- An offline Worker cannot receive new work.
- An unauthenticated provider is visible but cannot be started.
- The Hub never exposes Codeman endpoints or provider credentials directly.
- The two-host connector test and browser smoke test pass before release.

## Non-goals for this refactor

- Replacing Codeman's PTY or tmux implementation.
- Building a second general-purpose terminal emulator.
- Automatically logging into Cursor or Claude.
- Forking all of Codeman's UI and server without a concrete missing hook.
