import { expect, test } from "bun:test";
import type { ChildEnvironment } from "./data.ts";
import type { Ctx, Loaded, TaskClaim } from "./types.ts";
import { buildChildEnvironment, CLI_READ_TIMEOUT_MS } from "./data.ts";
import { holderEnvironment, renewalsDue, renewDueClaims } from "./renew.ts";
import type { RenewRun } from "./renew.ts";
import { turnEnded } from "./scan.ts";

const LEASE_MS = 1_800_000;
const RENEWED_AT = 1_000_000;
const HALF_LEASE = RENEWED_AT + LEASE_MS / 2;
const FAMILY = new Set(["ses_root", "ses_child"]);
const NO_LOCAL = new Map<string, number>();

function claim(over: Partial<TaskClaim> = {}): TaskClaim {
  return {
    state: "live",
    sessionId: "ses_root",
    threadId: null,
    renewedAt: RENEWED_AT,
    leaseMs: LEASE_MS,
    expiresAt: RENEWED_AT + LEASE_MS,
    ...over,
  };
}
function board(over: Partial<TaskClaim> = {}): Map<string, { claim: TaskClaim | null }> {
  return new Map([["ZTP-1", { claim: claim(over) }]]);
}
function toolTurn(idleID: string): Array<{
  id: string;
  type: string;
  text?: string;
  content?: Array<{ type: string }>;
}> {
  return [
    { id: "u1", type: "user", text: "fix ZTP-1" },
    {
      id: "a1",
      type: "assistant",
      content: [
        { type: "text" },
        { type: "tool" },
      ],
    },
    { id: idleID, type: "idle" },
  ];
}
function textTurn(idleID: string): Array<{
  id: string;
  type: string;
  content?: Array<{ type: string }>;
}> {
  return [
    { id: "a1", type: "assistant", content: [{ type: "text" }] },
    { id: idleID, type: "idle" },
  ];
}
type Toast = { variant?: string; title?: string; message: string };
function fakeContext(): { ctx: Ctx; toasts: Toast[] } {
  const toasts: Toast[] = [];
  const ctx = {
    ui: {
      toast: {
        show: (options: Toast) => toasts.push(options),
      },
    },
  } as unknown as Ctx;
  return { ctx, toasts };
}
type RunCall = { args: string[]; timeoutMs: number; environment: ChildEnvironment };
function fakeRunner(results: Loaded<string>[]) {
  const calls: RunCall[] = [];
  const run: RenewRun = async (args, timeoutMs = CLI_READ_TIMEOUT_MS, environment = {}) => {
    calls.push({ args, timeoutMs, environment });
    return results.shift() ?? { ok: true, value: "{}" };
  };
  return { calls, run };
}
function twoClaims(): Map<string, { claim: TaskClaim | null }> {
  return new Map([
    ["ZTP-1", { claim: claim() }],
    ["ZTP-2", { claim: claim() }],
  ]);
}

test("a claim renews at exactly half its lease", () => {
  expect(renewalsDue(board(), FAMILY, HALF_LEASE - 1, NO_LOCAL)).toEqual([]);
  expect(renewalsDue(board(), FAMILY, HALF_LEASE, NO_LOCAL)).toEqual(["ZTP-1"]);
});
test("a claim without a lease or renewal time is not due", () => {
  expect(renewalsDue(board({ leaseMs: null }), FAMILY, HALF_LEASE, NO_LOCAL)).toEqual([]);
  expect(renewalsDue(board({ renewedAt: null }), FAMILY, HALF_LEASE, NO_LOCAL)).toEqual([]);
});
test("an expired claim is not due", () => {
  expect(renewalsDue(board({ state: "expired" }), FAMILY, HALF_LEASE, NO_LOCAL)).toEqual([]);
  expect(renewalsDue(board({ expiresAt: HALF_LEASE }), FAMILY, HALF_LEASE, NO_LOCAL)).toEqual([]);
});
test("another holder's claim is not due", () => {
  const otherSession = board({ sessionId: "ses_other", threadId: null });
  const otherThread = board({ sessionId: null, threadId: "ses_other" });
  expect(renewalsDue(otherSession, FAMILY, HALF_LEASE, NO_LOCAL)).toEqual([]);
  expect(renewalsDue(otherThread, FAMILY, HALF_LEASE, NO_LOCAL)).toEqual([]);
});
test("a later local renewal time holds the claim back", () => {
  const local = new Map([["ZTP-1", RENEWED_AT + LEASE_MS * 0.4]]);
  expect(renewalsDue(board(), FAMILY, HALF_LEASE, local)).toEqual([]);
});
test("a claim this panel renewed outlives the row's stale expiry", () => {
  const local = new Map([["ZTP-1", RENEWED_AT + LEASE_MS / 2]]);
  const now = RENEWED_AT + LEASE_MS + 60_000;
  expect(renewalsDue(board(), FAMILY, now, NO_LOCAL)).toEqual([]);
  expect(renewalsDue(board(), FAMILY, now, local)).toEqual(["ZTP-1"]);
  expect(renewalsDue(board(), FAMILY, RENEWED_AT + LEASE_MS * 2, local)).toEqual([]);
});
test("an earlier local renewal time does not move the claim earlier", () => {
  const local = new Map([["ZTP-1", 0]]);
  expect(renewalsDue(board(), FAMILY, HALF_LEASE, local)).toEqual(["ZTP-1"]);
});
test("a stopped key is not due again", () => {
  expect(renewalsDue(board(), FAMILY, HALF_LEASE, NO_LOCAL, new Set(["ZTP-1"]))).toEqual([]);
});
test("a session holder sets the session and clears an inherited thread", () => {
  const environment = holderEnvironment(claim({ sessionId: "ses_root", threadId: "ses_child" }));
  expect(environment).toEqual({ ZINN_SESSION_ID: "ses_root", ZINN_THREAD_ID: null });
  const inherited = { ZINN_SESSION_ID: "ses_other", ZINN_THREAD_ID: "ses_other_child" };
  expect(buildChildEnvironment(inherited, environment ?? {})).toEqual({
    ZINN_SESSION_ID: "ses_root",
  });
});
test("a thread holder sets the thread and clears an inherited session", () => {
  const environment = holderEnvironment(claim({ sessionId: null, threadId: "ses_child" }));
  expect(environment).toEqual({ ZINN_SESSION_ID: null, ZINN_THREAD_ID: "ses_child" });
  const inherited = { ZINN_SESSION_ID: "ses_other", ZINN_THREAD_ID: "ses_other_child" };
  expect(buildChildEnvironment(inherited, environment ?? {})).toEqual({
    ZINN_THREAD_ID: "ses_child",
  });
});
test("a claim with no identity cannot run a heartbeat", () => {
  expect(holderEnvironment(claim({ sessionId: null, threadId: null }))).toBeNull();
});
test("a turn that ran a tool reports a tool", () => {
  expect(turnEnded(toolTurn("idle-1"), undefined)).toEqual({ id: "idle-1", ranTool: true });
});
test("a turn with only text reports no tool", () => {
  expect(turnEnded(textTurn("idle-1"), undefined)).toEqual({ id: "idle-1", ranTool: false });
});
test("mounting on an idle message is not a turn", () => {
  expect(turnEnded(toolTurn("idle-1"), "idle-1")).toBeUndefined();
  expect(turnEnded(textTurn("idle-1"), "idle-1")).toBeUndefined();
});
test("a turn that has not ended yet is not a turn", () => {
  const messages = [...textTurn("idle-1"), { id: "a2", type: "assistant" }];
  expect(turnEnded(messages, "idle-1")).toBeUndefined();
});
test("a tool call from an earlier turn does not count", () => {
  const messages = [
    { id: "a1", type: "assistant", content: [{ type: "tool" }] },
    { id: "idle-1", type: "idle" },
    { id: "a2", type: "assistant", content: [{ type: "text" }] },
    { id: "idle-2", type: "idle" },
  ];
  expect(turnEnded(messages, "idle-1")).toEqual({ id: "idle-2", ranTool: false });
});
test("a successful heartbeat records the local renewal time", async () => {
  const { ctx, toasts } = fakeContext();
  const { calls, run } = fakeRunner([{ ok: true, value: "{}" }]);
  const localRenewals = new Map<string, number>();
  const stopped = new Set<string>();

  await renewDueClaims({
    ctx,
    tasks: board(),
    family: FAMILY,
    localRenewals,
    stopped,
    now: HALF_LEASE,
    run,
  });

  expect(calls).toHaveLength(1);
  expect(calls[0]?.args).toEqual(["task", "heartbeat", "ZTP-1", "--json"]);
  expect(calls[0]?.timeoutMs).toBe(CLI_READ_TIMEOUT_MS);
  expect(calls[0]?.environment).toEqual({
    ZINN_SESSION_ID: "ses_root",
    ZINN_THREAD_ID: null,
  });
  expect(localRenewals.get("ZTP-1")).toBeNumber();
  expect(stopped.size).toBe(0);
  expect(toasts).toHaveLength(0);
});
for (const reason of ["claimed", "claim_limit", "not_claimed"] as const) {
  test(`a ${reason} refusal toasts once and stops the key`, async () => {
    const { ctx, toasts } = fakeContext();
    const { calls, run } = fakeRunner([
      { ok: false, error: "refused", code: "conflict", reason },
    ]);
    const localRenewals = new Map<string, number>();
    const stopped = new Set<string>();
    const input = {
      ctx,
      tasks: board(),
      family: FAMILY,
      localRenewals,
      stopped,
      now: HALF_LEASE,
      run,
    };

    await renewDueClaims(input);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.variant).toBe("warning");
    expect(stopped.has("ZTP-1")).toBe(true);
    expect(localRenewals.size).toBe(0);

    await renewDueClaims(input);
    expect(calls).toHaveLength(1);
    expect(toasts).toHaveLength(1);
  });
}
test("an unknown refusal reason is logged and retried at the next run", async () => {
  const { ctx, toasts } = fakeContext();
  const { calls, run } = fakeRunner([
    { ok: false, error: "invalid heartbeat", code: "invalid_input", reason: "invalid_input" },
    { ok: true, value: "{}" },
  ]);
  const localRenewals = new Map<string, number>();
  const stopped = new Set<string>();
  const input = {
    ctx,
    tasks: board(),
    family: FAMILY,
    localRenewals,
    stopped,
    now: HALF_LEASE,
    run,
  };

  await renewDueClaims(input);
  expect(toasts).toHaveLength(0);
  expect(stopped.size).toBe(0);

  await renewDueClaims(input);
  expect(calls).toHaveLength(2);
  expect(localRenewals.has("ZTP-1")).toBe(true);
});
test("a failure without a reason is logged and retried at the next run", async () => {
  const { ctx, toasts } = fakeContext();
  const { calls, run } = fakeRunner([
    { ok: false, error: "zinn read timed out after 15000 ms" },
    { ok: true, value: "{}" },
  ]);
  const localRenewals = new Map<string, number>();
  const stopped = new Set<string>();
  const input = {
    ctx,
    tasks: board(),
    family: FAMILY,
    localRenewals,
    stopped,
    now: HALF_LEASE,
    run,
  };

  await renewDueClaims(input);
  expect(toasts).toHaveLength(0);
  expect(stopped.size).toBe(0);

  await renewDueClaims(input);
  expect(calls).toHaveLength(2);
});
test("an alive check that turns false stops the loop", async () => {
  let alive = true;
  const { ctx } = fakeContext();
  const calls: string[] = [];
  const run: RenewRun = async (args) => {
    calls.push(args[2] ?? "");
    alive = false;
    return { ok: true, value: "{}" };
  };

  await renewDueClaims({
    ctx,
    tasks: twoClaims(),
    family: FAMILY,
    localRenewals: new Map(),
    stopped: new Set(),
    now: HALF_LEASE,
    alive: () => alive,
    run,
  });

  expect(calls).toEqual(["ZTP-1"]);
});
