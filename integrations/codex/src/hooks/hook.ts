import type { HookPayload } from "./types";

import { loadSettings } from "../settings";
import { rewrite } from "./identity";
import { lookupEffort } from "./effort";
import { observe } from "./observe";
import { HOOK_VERIFICATION_BUDGET_MS } from "../shared/cli";

const MAX_INPUT_BYTES = 1024 * 1024;
const verificationDeadline = performance.now() + HOOK_VERIFICATION_BUDGET_MS;
const cancellation = new AbortController();
function cancel() {
  cancellation.abort();
  process.stdin.destroy();
}

process.once("SIGTERM", cancel);
process.once("SIGINT", cancel);

let payload: HookPayload | undefined;
let output: Record<string, unknown> | null = null;

try {
  let input = "";
  process.stdin.setEncoding("utf8");

  for await (const chunk of process.stdin) {
    input += chunk.toString();
    if (Buffer.byteLength(input) > MAX_INPUT_BYTES) {
      throw new Error("Oversized hook input.");
    }
  }

  payload = JSON.parse(input);
  const settings = loadSettings();

  if (payload && settings.identity) {
    output = rewrite(payload, settings.cli);
    if (output && settings.captureEffort) {
      output = rewrite(payload, settings.cli, lookupEffort(payload).effort);
    }
  }

  if (payload) {
    try {
      await observe(payload, settings, {
        deadline: verificationDeadline,
        signal: cancellation.signal,
      });
    } catch {
      // Observation failures must not change command execution or attribution.
    }
  }
} catch {
  // Optional hooks leave the operation unchanged when configuration is unavailable.
}

if (output !== null) {
  process.stdout.write(JSON.stringify(output) + "\n");
} else if (payload?.hook_event_name === "Stop" || payload?.hook_event_name === "SubagentStop") {
  process.stdout.write("{}\n");
}
