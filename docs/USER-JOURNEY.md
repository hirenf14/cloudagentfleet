# User Journey

## Persona

An individual developer with several always-on machines. Each machine may host
Codeman, a Cursor worker, a Claude runner, or a local project environment.

## Happy path

### 1. Pair a machine

The developer installs the Hosted Agents companion beside Codeman, chooses
approved folders or explicitly grants whole-system access, names the machine,
and approves a one-time pairing code. The machine appears online with its
platform, capabilities, provider readiness, workspaces, and last-seen time.

### 2. Prepare a workspace

The developer selects a machine first, then chooses one of that machine's
discovered workspaces. A machine may expose multiple workspaces, but every
workspace must remain inside the Worker's local access policy.

### 3. Select an agent

- Codeman for persistent terminal and CLI sessions
- Cursor for an official Cursor worker
- Claude for an official Claude runner

Hosted Agents shows only agents ready for the selected workspace. It validates
the workspace, machine, isolation mode, and provider configuration before launch.

### 4. Launch a task

The developer enters a prompt and starts the task. Hosted Agents creates an
idempotent job containing the selected machine, workspace ID, and agent
provider, then assigns it once to the selected Worker.

### 5. Inspect progress

The developer can:

- Watch the Codeman terminal and persistent session output
- Open an authenticated localhost preview URL
- Map the preview to local `127.0.0.1` with the tunnel helper
- Open an interactive Chromium viewport running on the selected machine

The developer can work from a laptop or phone without opening an inbound port
on the host machine.

### 6. Unblock the agent

When the agent needs input, the developer answers a question, approves a
destructive action, sends a follow-up, or cancels the job. Each intervention is
scoped to the job and recorded in the audit log.

### 7. Finish safely

The developer reviews the result and artifacts. Hosted Agents closes or expires
preview leases, removes disposable browser profiles, transitions the job to a
terminal state, and leaves the machine ready for another task.

## Failure journeys

- **Machine offline:** no new jobs are assigned; active work becomes visibly
  degraded and can be retried or cancelled.
- **Provider unavailable:** the provider-specific error is shown; execution
  does not silently switch to another provider.
- **Preview disconnected:** the lease can reconnect while valid or be revoked
  immediately by the operator.
- **Node compromised:** the operator revokes its identity, disconnects it, and
  stops all jobs and leases associated with it.

## Product success

The journey is complete when the developer can move from pairing a machine to
reviewing a finished change without manually SSH-ing between hosts, exposing a
public development port, or copying provider credentials into the control
plane.
