declare const process: {
  argv: string[];
  exitCode?: number;
};

export interface SetupEnvironment {
  platform: "linux" | "macos" | "windows";
  wsl: boolean;
  node: boolean;
  git: boolean;
  codeman: boolean;
  tmux: boolean;
  docker: boolean;
  browser: boolean;
  cursorCli: boolean;
  claudeCli: boolean;
}

export interface SetupStep {
  id:
    | "check"
    | "pair"
    | "identity"
    | "service"
    | "health";
  title: string;
  required: boolean;
  confirmation: "none" | "required";
}

export function createSetupPlan(environment: SetupEnvironment): SetupStep[] {
  const steps: SetupStep[] = [
    {
      id: "check",
      title: "Check operating system, runtime, and optional integrations",
      required: true,
      confirmation: "none",
    },
    {
      id: "pair",
      title: "Pair this machine with a one-time control-plane code",
      required: true,
      confirmation: "required",
    },
    {
      id: "identity",
      title: "Create and protect a machine-local node identity",
      required: true,
      confirmation: "required",
    },
    {
      id: "service",
      title: "Install a user-level startup service for the Hosted Agents Worker",
      required: true,
      confirmation: "required",
    },
    {
      id: "health",
      title: "Verify outbound connectivity and detected capabilities",
      required: true,
      confirmation: "none",
    },
  ];

  if (environment.platform === "windows" && !environment.wsl) {
    steps[0] = {
      ...steps[0],
      title: "Check Windows runtime and optional WSL integration",
    };
  }

  return steps;
}

function usage(): void {
  console.log(
    [
      "Hosted Agents CLI",
      "",
      "Usage:",
      "  hosted-agents setup       Check and prepare this machine",
      "  hosted-agents check       Print detected integration requirements",
      "",
      "Setup is confirmation-based. It never performs provider login or copies provider credentials into the Controller.",
    ].join("\n"),
  );
}

function main(argv: string[]): void {
  const command = argv[2] ?? "help";
  if (command === "help" || command === "--help" || command === "-h") {
    usage();
    return;
  }

  if (command !== "setup" && command !== "check") {
    console.error(`Unknown command: ${command}`);
    process.exitCode = 1;
    return;
  }

  const environment: SetupEnvironment = {
    platform: "windows",
    wsl: false,
    node: true,
    git: true,
    codeman: false,
    tmux: false,
    docker: false,
    browser: true,
    cursorCli: false,
    claudeCli: false,
  };

  console.log(JSON.stringify({ command, environment, steps: createSetupPlan(environment) }, null, 2));
}

if (typeof process !== "undefined" && process.argv[1]?.endsWith("index.ts")) {
  main(process.argv);
}
