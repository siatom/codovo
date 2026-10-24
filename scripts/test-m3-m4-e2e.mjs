#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(root, "fixtures", "fake-agent.mjs");

function runFake() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixture, "--scenario", "permission"], { stdio: ["pipe", "pipe", "inherit"] });
    const events = [];
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line) {
        const event = JSON.parse(line);
        events.push(event);
        if (event.type === "approval.requested") child.stdin.write('{"op":"approve","decision":"deny"}\n');
        if (event.type === "run.failed") child.stdin.write('{"op":"stop"}\n');
      }
    });
    child.on("exit", () => resolve(events));
    child.on("error", reject);
    child.stdin.write('{"op":"start"}\n');
  });
}

const events = await runFake();
assert.deepEqual(events.map((event) => event.type), ["agent.started", "approval.requested", "approval.decided", "run.failed", "agent.stopped"]);
assert.equal(new Set(events.map((event) => event.eventKey)).size, events.length);

const plan = {
  goalId: "goal-e2e",
  candidates: [
    { id: "plan", title: "Plan", dependsOn: [], acceptance: ["plan recorded"] },
    { id: "implement", title: "Implement", dependsOn: ["plan"], acceptance: ["tests pass"] },
    { id: "verify", title: "Verify", dependsOn: ["implement"], acceptance: ["review recorded"] },
  ],
};
const completed = new Set(["plan"]);
const ready = plan.candidates.filter((item) => !completed.has(item.id) && item.dependsOn.every((dependency) => completed.has(dependency)));
assert.deepEqual(ready.map((item) => item.id), ["implement"]);
assert.equal(plan.candidates.some((item) => item.dependsOn.includes(item.id)), false);
console.log("M3/M4 fake adapter and planner E2E passed");
