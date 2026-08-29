# Product Requirements: Hosted Agents

## Objective

Give one owner a secure Controller for multiple always-on Worker machines
running Codeman, Cursor runtimes, Claude runners, or local agent sessions. The
Controller is a router and coordinator; execution remains on Workers.

## Primary user

A developer with several personal machines—such as a workstation, Mac mini,
home server, or VPS—who wants to start, inspect, and unblock coding agents from
one browser.

## V1 requirements

1. Run `hosted-agents setup` to check prerequisites, pair a machine with a
   one-time enrollment code, install the companion as a user-level service, and
   display its health.
2. Provide a signed standalone installer and guided CLI that works without
   Cursor, Claude, Codeman, or an AI agent running.
3. Configure a Worker with either one or more approved default folders or an
   explicitly approved whole-system scope.
4. Discover and display multiple workspaces per Worker, including canonical
   path, name, provider readiness, and workspace health.
5. Install and persist the Hosted Agents worker as a user-level background
   service. Detect Codeman, Cursor, and Claude readiness without taking over
   their login or provider-worker setup.
6. Reuse Codeman for persistent tmux sessions, live terminal output, remote SSH
   cases, and optional Docker isolation.
7. Start work using the ordered flow: select machine, select workspace, select
   agent/provider, then start.
8. Show all active agent sessions in a live sidebar grouped by Worker and
   workspace, including provider, status, needs-input state, and preview/browser
   availability.
9. Offer a collapsible sidebar view and a responsive card/grid view backed by
   the same session state; selecting either opens the same session detail view.
10. Forward a session's localhost preview through an authenticated browser URL.
11. Provide an optional local tunnel that maps a remote preview to
   `127.0.0.1:<available-port>`.
12. Open an isolated Chromium session on a machine, show its webpage viewport in
   the dashboard, and relay authorized mouse and keyboard events.
13. Integrate official Cursor and Claude worker/runner paths without conflating
   their credentials or control planes.
14. Record auditable lifecycle events and provide an emergency stop/revoke
   action.

## Non-goals for V1

- Public signup, billing, or multi-tenant SaaS.
- Silent installation of provider CLIs, credentials, or privileged system
  services.
- Replacing Codeman's terminal/session implementation.
- Full operating-system desktop streaming.
- Raw Chrome DevTools Protocol exposure.
- Arbitrary public port publishing.
- Automatic forwarding of machine credentials into agent jobs.

## Acceptance criteria

- A revoked machine cannot reconnect or receive work.
- An offline machine is never selected for a new job.
- A job cannot start against a workspace outside the Worker's locally enforced
  access scope.
- Duplicate deliveries do not create duplicate sessions.
- Preview URLs require authentication and expire or can be revoked.
- Browser sessions use disposable profiles by default.
- Secrets and authorization headers are absent from UI, audit events, and logs.
- An operator can stop all jobs and revoke all active preview/browser sessions.
