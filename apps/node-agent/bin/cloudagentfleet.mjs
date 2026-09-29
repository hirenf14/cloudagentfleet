#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const root = dirname(fileURLToPath(import.meta.url));
const packaged = join(root, "..", "cli", "hosted-agents.mjs");
const monorepo = join(root, "..", "..", "cli", "bin", "hosted-agents.mjs");
const entry = existsSync(packaged) ? packaged : monorepo;
await import(pathToFileURL(entry).href);
