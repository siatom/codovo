#!/usr/bin/env node

/** Offline Agent CLI fixture for the CODO-004 adapter contract tests. */
import readline from "node:readline";

const args = process.argv.slice(2);
const scenarioIndex = args.indexOf("--scenario");
const scenario = scenarioIndex >= 0 ? args[scenarioIndex + 1] ?? "success" : "success";
const validScenarios = new Set(["success", "failure", "permission", "duplicate", "slow"]);

if (!validScenarios.has(scenario)) {
  process.stderr.write(`unknown scenario: ${scenario}\n`);
  process.exitCode = 2;
}

let started = false;
let settled = false;

function emit(event) {
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ...event })}\n`);
}

function start() {
  if (started) return;
  started = true;
  emit({ type: "agent.started", eventKey: "fake:start", scenario });

  if (scenario === "permission") {
    emit({ type: "approval.requested", eventKey: "fake:approval:1", permission: "write" });
    return;
  }
  if (scenario === "slow") return;

  const event =
    scenario === "failure"
      ? { type: "run.failed", eventKey: "fake:run:failed", reason: "fixture failure" }
      : { type: "run.succeeded", eventKey: "fake:run:succeeded", exitCode: 0 };
  emit(event);
  if (scenario === "duplicate") emit(event);
  settled = true;
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    emit({ type: "protocol.error", eventKey: `fake:protocol:${Date.now()}`, reason: "invalid JSON" });
    return;
  }

  if (request.op === "start") start();
  else if (request.op === "cancel" && !settled) {
    emit({ type: "run.cancelled", eventKey: "fake:run:cancelled", reason: "requested" });
    settled = true;
  } else if (request.op === "stop") {
    emit({ type: "agent.stopped", eventKey: "fake:stopped" });
    process.exit(0);
  } else if (request.op === "approve" && scenario === "permission") {
    emit({ type: "approval.decided", eventKey: "fake:approval:1:decision", decision: request.decision ?? "deny" });
    emit({ type: request.decision === "allow" ? "run.succeeded" : "run.failed", eventKey: "fake:run:permission", exitCode: 0 });
    settled = true;
  }
});
