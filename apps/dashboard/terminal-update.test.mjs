import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// app.js is a browser script with no exports; evaluate just the terminalUpdate function from it.
const source = readFileSync(new URL("./public/app.js", import.meta.url), "utf8");
const body = source.slice(source.indexOf("// terminalUpdate:start"), source.indexOf("// terminalUpdate:end"));
const terminalUpdate = new Function(`${body}; return terminalUpdate;`)();

test("a polled buffer that continues the screen only appends", () => {
  assert.deepEqual(terminalUpdate("abc", "abcdef"), { reset: false, write: "def" });
  assert.deepEqual(terminalUpdate("abc", "abc"), { reset: false, write: "" });
});

test("the Hub's sliding 20K window appends instead of redrawing", () => {
  const screen = "x".repeat(25_000) + "line 1\nline 2\n";
  const polled = screen.slice(-20_000) + "line 3\n"; // tail only: no longer starts with the screen
  assert.deepEqual(terminalUpdate(screen, polled), { reset: false, write: "line 3\n" });
});

test("a poll older than the streamed output changes nothing", () => {
  assert.deepEqual(terminalUpdate("prompt> hello world", "hello world"), { reset: false, write: "" });
});

test("a first buffer, or one that matches nothing, redraws", () => {
  assert.deepEqual(terminalUpdate("", "boot"), { reset: true, write: "boot" });
  assert.deepEqual(terminalUpdate("old session text", "something else"), { reset: true, write: "something else" });
});
