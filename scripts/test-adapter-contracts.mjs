import { spawnSync } from "node:child_process";

const probes = [
  ["codex", ["exec", "--help"], ["--json", "resume"]],
  ["opencode", ["--help"], ["--server", "--session"]],
  ["claude", ["--help"], ["--print", "--output-format"]],
  ["codebuddy", ["--help"], ["stream-json", "--serve", "--acp"]],
];

for (const [name, args, expected] of probes) {
  const result = spawnSync(`${name}.cmd`, args, { encoding: "utf8", windowsHide: true, shell: true });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.error || result.status !== 0) throw new Error(`${name} help failed: ${result.error?.message ?? result.status}`);
  for (const needle of expected) if (!output.includes(needle)) throw new Error(`${name} help missing ${needle}`);
  if (/dangerously-skip-permissions|bypassPermissions/.test(output) && name !== "codebuddy" && name !== "claude") {
    throw new Error(`${name} exposed an unexpected bypass flag`);
  }
}
console.log("adapter contract probes passed");
