#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const command = process.argv[2] ?? "help";
const json = process.argv.includes("--json");

function canRun(commandName) {
  const result = spawnSync(commandName, ["--version"], {
    stdio: "ignore",
    shell: process.platform === "win32",
  });
  return result.status === 0;
}

function detectBrowser() {
  return [
    "google-chrome",
    "chromium",
    "chromium-browser",
    "msedge",
    "firefox",
  ].some(canRun);
}

function detectEnvironment() {
  const platform =
    process.platform === "darwin"
      ? "macos"
      : process.platform === "win32"
        ? "windows"
        : "linux";

  return {
    platform,
    wsl: Boolean(process.env.WSL_DISTRO_NAME),
    node: true,
    git: canRun("git"),
    codeman: canRun("codeman") || canRun("aicodeman"),
    tmux: canRun("tmux"),
    docker: canRun("docker"),
    browser: detectBrowser(),
    cursorCli: canRun("agent") || canRun("cursor"),
    claudeCli: canRun("claude"),
  };
}

function setupSteps(environment) {
  const steps = [
    {
      id: "check",
      title: "Check operating system, runtime, and integrations",
      required: true,
      confirmation: false,
    },
    {
      id: "pair",
      title: "Pair this machine with a short-lived dashboard code",
      required: true,
      confirmation: true,
    },
    {
      id: "identity",
      title: "Create and protect a machine-local node identity",
      required: true,
      confirmation: true,
    },
    {
      id: "service",
      title: "Install a user-level startup service for the companion",
      required: true,
      confirmation: true,
    },
    {
      id: "health",
      title: "Verify outbound connectivity and detected capabilities",
      required: true,
      confirmation: false,
    },
  ];

  if (environment.platform === "windows" && !environment.wsl) {
    steps[0].title = "Check Windows runtime and optional WSL integration";
  }

  return steps;
}

function workerPlans(environment) {
  const workers = [
    {
      id: "hosted-agents-node",
      available: true,
      action: "Install and start the persistent Hosted Agents worker service",
      command: "hosted-agents worker install && hosted-agents worker start",
    },
    {
      id: "codeman",
      available: environment.codeman,
      action: environment.codeman
        ? "Report the existing Codeman runtime and persistent sessions"
        : "Report Codeman as unavailable; installation remains optional",
      command: "codeman --version",
    },
    {
      id: "cursor",
      available: environment.cursorCli,
      action: environment.cursorCli
        ? "Report Cursor CLI and authentication readiness only"
        : "Report Cursor CLI as unavailable",
      command: "agent worker debug",
    },
    {
      id: "claude",
      available: environment.claudeCli,
      action: environment.claudeCli
        ? "Report Claude Code and runner readiness only"
        : "Report Claude Code as unavailable",
      command: "claude --version",
    },
  ];

  return workers;
}

function render(environment) {
  const result = {
    command,
    environment,
    steps: setupSteps(environment),
    workers: workerPlans(environment),
    notes: [
      "Missing optional integrations are reported, not silently installed.",
      "Provider credentials remain on the machine and are never copied into the control plane.",
      "Pairing, identity storage, and service installation require explicit confirmation.",
    ],
  };

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log("Hosted Agents setup");
  console.log("===================");
  console.log(`Platform: ${environment.platform}${environment.wsl ? " (WSL)" : ""}`);
  console.log("");
  console.log("Detected integrations:");
  for (const [name, available] of Object.entries(environment)) {
    if (name === "platform" || name === "wsl") continue;
    console.log(`  ${available ? "[ok]" : "[--]"} ${name}`);
  }
  console.log("");
  console.log("Setup steps:");
  for (const [index, step] of result.steps.entries()) {
    const approval = step.confirmation ? "approval required" : "automatic check";
    console.log(`  ${index + 1}. ${step.title} (${approval})`);
  }
  if (process.argv.includes("--workers")) {
    console.log("");
    console.log("Worker setup:");
    for (const worker of result.workers) {
      console.log(`  ${worker.available ? "[ready]" : "[setup]"} ${worker.id}`);
      console.log(`         ${worker.action}`);
      console.log(`         ${worker.command}`);
    }
  }
  console.log("");
  for (const note of result.notes) console.log(`Note: ${note}`);
  console.log("");
  console.log(
    command === "check"
      ? "This was a read-only prerequisite check."
      : "Pairing and installation actions will be enabled after the control plane is connected.",
  );
}

if (command === "help" || command === "--help" || command === "-h") {
  console.log(
    [
      "Hosted Agents CLI",
      "",
      "Usage:",
      "  hosted-agents setup [--json]",
      "  hosted-agents check [--json]",
      "",
      "The current bootstrap is read-only and confirmation-safe.",
    ].join("\n"),
  );
} else if (command === "setup" || command === "check") {
  render(detectEnvironment());
} else {
  console.error(`Unknown command: ${command}`);
  process.exitCode = 1;
}
