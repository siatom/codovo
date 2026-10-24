#!/usr/bin/env node

import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(root, "fixtures", "fake-agent.mjs");

class FakeAdapter {
  #child;
  #events = [];
  #waiters = [];

  constructor(scenario) {
    this.#child = spawn(process.execPath, [fixture, "--scenario", scenario], { stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        const event = JSON.parse(line);
        this.#events.push(event);
        this.#waiters = this.#waiters.filter((waiter) => !waiter(event));
      }
    });
  }

  send(request) {
    this.#child.stdin.write(`${JSON.stringify(request)}\n`);
  }

  async waitFor(type, timeoutMs = 1500) {
    const existing = this.#events.find((event) => event.type === type);
    if (existing) return existing;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
      this.#waiters.push((event) => {
        if (event.type !== type) return false;
        clearTimeout(timer);
        resolve(event);
        return true;
      });
    });
  }

  events() {
    return [...this.#events];
  }

  async stop() {
    this.send({ op: "stop" });
    await once(this.#child, "exit");
  }
}

async function successLifecycle() {
  const adapter = new FakeAdapter("success");
  adapter.send({ op: "start" });
  await adapter.waitFor("agent.started");
  await adapter.waitFor("run.succeeded");
  assert.equal(adapter.events().filter((event) => event.type === "run.succeeded").length, 1);
  await adapter.stop();
}

async function failureAndCancelLifecycle() {
  const failed = new FakeAdapter("failure");
  failed.send({ op: "start" });
  await failed.waitFor("run.failed");
  await failed.stop();

  const cancelled = new FakeAdapter("slow");
  cancelled.send({ op: "start" });
  await cancelled.waitFor("agent.started");
  cancelled.send({ op: "cancel" });
  await cancelled.waitFor("run.cancelled");
  await cancelled.stop();
}

async function duplicateAndPermissionLifecycle() {
  const duplicate = new FakeAdapter("duplicate");
  duplicate.send({ op: "start" });
  await duplicate.waitFor("run.succeeded");
  assert.equal(duplicate.events().filter((event) => event.eventKey === "fake:run:succeeded").length, 2);
  await duplicate.stop();

  const permission = new FakeAdapter("permission");
  permission.send({ op: "start" });
  await permission.waitFor("approval.requested");
  permission.send({ op: "approve", decision: "deny" });
  await permission.waitFor("approval.decided");
  await permission.waitFor("run.failed");
  await permission.stop();
}

await successLifecycle();
await failureAndCancelLifecycle();
await duplicateAndPermissionLifecycle();
console.log("fake agent lifecycle tests passed");
