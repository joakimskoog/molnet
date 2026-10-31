import { afterAll, beforeEach, expect, test } from "bun:test";
import { toState, cloudAgentStatus } from "./src/molnet";
import type { Session, SessionStatus, SessionStatusDetail } from "./src/types";

type Request = { method: string; path: string; auth: string | null; body: any };
let requests: Request[] = [];
beforeEach(() => (requests = []));

function fakeSession(id: string, status: string, status_detail: string | null, prs: string[] = []) {
  return {
    session_id: id,
    url: `https://app.devin.ai/sessions/${id}`,
    status,
    status_detail,
    pull_requests: prs.map((pr_url) => ({ pr_url, pr_state: "open" })),
  };
}

// Sessions served by GET /v3/organizations/org-test/sessions/<id>; any other id is a 403, as the real API answers.
const fakeSessions: Record<string, () => Response> = {
  "s-working": () => Response.json(fakeSession("s-working", "running", "working")),
  "s-idle": () => Response.json(fakeSession("s-idle", "running", "finished", ["https://github.com/a/b/pull/1"])),
  "s-failed": () => Response.json(fakeSession("s-failed", "suspended", "out_of_credits")),
  "s-500": () => new Response("boom", { status: 500 }),
  "s-then-idle": sequence("s-then-idle", [["running", "working"], ["running", "waiting_for_user"]]),
  "s-then-failed": sequence("s-then-failed", [["claimed", null], ["suspended", "out_of_quota"]]),
  "s-idle-at-deadline": sequence("s-idle-at-deadline", [["running", "working"], ["running", "waiting_for_user"]]),
  "s-then-weird": sequence("s-then-weird", [["running", "working"], ["sleeping", null]]),
  "s-weird": () => Response.json(fakeSession("s-weird", "sleeping", null)),
};

// Serves each state in turn, then repeats the last one.
function sequence(id: string, states: [string, string | null][]) {
  let polls = 0;
  return () => Response.json(fakeSession(id, ...states[Math.min(polls++, states.length - 1)]!));
}

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (req.method === "GET") {
      requests.push({ method: req.method, path, auth: req.headers.get("authorization"), body: null });
      const id = path.slice("/v3/organizations/org-test/sessions/".length);
      return fakeSessions[id]?.() ?? Response.json({ type: "about:blank", title: "Forbidden", status: 403, detail: "Unauthorized", instance: path }, { status: 403 });
    }
    const body: any = await req.json();
    requests.push({ method: req.method, path, auth: req.headers.get("authorization"), body });
    if (body.prompt === "fail") return new Response("nope", { status: 403 });
    return Response.json({ session_id: "abc", url: "https://app.devin.ai/sessions/abc", status: "new", title: "ignored" });
  },
});
afterAll(() => server.stop());

async function molnet(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, "src/molnet.ts", ...args], {
    cwd: import.meta.dir,
    env: { ...process.env, DEVIN_API_KEY: "cog_test", DEVIN_ORG_ID: "org-test", DEVIN_API_URL: server.url.href, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test("spawn <prompt> creates a session and prints minimal JSON", async () => {
  const { stdout, stderr, exitCode } = await molnet(["spawn", "Fix it"]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  expect(JSON.parse(stdout)).toEqual({ session_id: "abc", url: "https://app.devin.ai/sessions/abc", status: "new" });
  expect(requests).toEqual([
    { method: "POST", path: "/v3/organizations/org-test/sessions", auth: "Bearer cog_test", body: { prompt: "Fix it" } },
  ]);
});

test("spawn sends all options, before or after the prompt", async () => {
  const { exitCode, stderr } = await molnet(["spawn", "--max-acu-limit", "5", "Fix it", "--devin-mode", "fast"]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  expect(requests[0]?.body).toEqual({ prompt: "Fix it", max_acu_limit: 5, devin_mode: "fast" });
});

test("spawn accepts a prompt starting with - after --", async () => {
  const { exitCode } = await molnet(["spawn", "--devin-mode", "fast", "--", "--not-a-flag"]);
  expect(exitCode).toBe(0);
  expect(requests[0]?.body).toEqual({ prompt: "--not-a-flag", devin_mode: "fast" });
});

test("spawn validates input before calling the API", async () => {
  const cases: [string[], string][] = [
    [["spawn"], "spawn requires exactly one prompt argument (quote it), got 0"],
    [["spawn", "Fix", "it"], "spawn requires exactly one prompt argument (quote it), got 2"],
    [["spawn", "  "], "Prompt is empty"],
    [["spawn", "x", "--max-acu-limit", "0"], "--max-acu-limit must be a positive integer"],
    [["spawn", "x", "--max-acu-limit", "1.5"], "--max-acu-limit must be a positive integer"],
    [["spawn", "x", "--devin-mode", "turbo"], "--devin-mode must be one of"],
    [["spawn", "x", "--prompt", "t"], "Unknown option '--prompt'"],
    [["spawn", "x", "--no-resumable"], "Unknown option '--no-resumable'"],
  ];
  for (const [args, error] of cases) {
    const { stdout, stderr, exitCode } = await molnet(args);
    expect(stdout).toBe("");
    expect(stderr).toContain(error);
    expect(exitCode).toBe(1);
  }
  expect(requests).toEqual([]);
});

test("spawn reports API errors and missing credentials", async () => {
  const apiError = await molnet(["spawn", "fail"]);
  expect(apiError.stdout).toBe("");
  expect(apiError.stderr).toContain("failed with 403: nope");
  expect(apiError.exitCode).toBe(1);

  const noKey = await molnet(["spawn", "x"], { DEVIN_API_KEY: "" });
  expect(noKey.stderr).toContain("Missing apiKey");
  expect(noKey.exitCode).toBe(1);
});

const sessionPath = (id: string) => `/v3/organizations/org-test/sessions/${id}`;

test("status <id> prints one status line", async () => {
  const { stdout, stderr, exitCode } = await molnet(["status", "s-idle"]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  expect(stdout).toBe('{"session_id":"s-idle","state":"idle","pull_requests":["https://github.com/a/b/pull/1"]}\n');
  expect(requests).toEqual([{ method: "GET", path: sessionPath("s-idle"), auth: "Bearer cog_test", body: null }]);
});

test("status prints lines in argument order, with a repeated id printed and fetched once", async () => {
  const { stdout, stderr, exitCode } = await molnet(["status", "s-failed", "s-working", "s-failed", "s-idle", "s-working"]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  expect(stdout.trimEnd().split("\n").map((line) => JSON.parse(line))).toEqual([
    { session_id: "s-failed", state: "failed", pull_requests: [] },
    { session_id: "s-working", state: "working", pull_requests: [] },
    { session_id: "s-idle", state: "idle", pull_requests: ["https://github.com/a/b/pull/1"] },
  ]);
  expect(requests.map((r) => r.path).sort()).toEqual(["s-failed", "s-idle", "s-working"].map(sessionPath));
});

test("status fails with nothing on stdout if any id is unknown", async () => {
  const { stdout, stderr, exitCode } = await molnet(["status", "s-idle", "nope-1", "s-working"]);
  expect(stdout).toBe("");
  expect(stderr).toContain("failed with 403");
  expect(exitCode).toBe(1);
});

test("status rejects a blank id without calling the API", async () => {
  for (const id of ["", "  "]) {
    const { stdout, stderr, exitCode } = await molnet(["status", "s-idle", id]);
    expect(stdout).toBe("");
    expect(stderr).toBe("molnet: session id is empty\n");
    expect(exitCode).toBe(1);
  }
  expect(requests).toEqual([]);
});

test("status fails with nothing on stdout on another API error", async () => {
  const { stdout, stderr, exitCode } = await molnet(["status", "s-idle", "s-500"]);
  expect(stdout).toBe("");
  expect(stderr).toContain("molnet: GET");
  expect(stderr).toContain("failed with 500: boom");
  expect(exitCode).toBe(1);
});

test("status prints nothing if any session has an unrecognized status", async () => {
  const { stdout, stderr, exitCode } = await molnet(["status", "s-idle", "s-weird"]);
  expect(stdout).toBe("");
  expect(stderr).toBe("molnet: unrecognized session status sleeping/null\n");
  expect(exitCode).toBe(1);
});

test("status without ids fails without calling the API", async () => {
  const { stdout, stderr, exitCode } = await molnet(["status"]);
  expect(stdout).toBe("");
  expect(stderr).toBe("molnet: status requires at least one session id\n");
  expect(exitCode).toBe(1);
  expect(requests).toEqual([]);
});

test("status --help prints usage and exits 0", async () => {
  for (const flag of ["--help", "-h"]) {
    const { stdout, exitCode } = await molnet(["status", flag], { DEVIN_API_KEY: "" });
    expect(stdout).toContain("Usage: molnet status");
    expect(exitCode).toBe(0);
  }
  expect(requests).toEqual([]);
});

test("wait returns at once, with exit 0, for an idle session", async () => {
  const { stdout, stderr, exitCode } = await molnet(["wait", "s-idle"]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  expect(stdout).toBe('{"session_id":"s-idle","state":"idle","pull_requests":["https://github.com/a/b/pull/1"]}\n');
  expect(requests).toEqual([{ method: "GET", path: sessionPath("s-idle"), auth: "Bearer cog_test", body: null }]);
});

test("wait returns at once, with exit 2, for a failed session", async () => {
  const { stdout, stderr, exitCode } = await molnet(["wait", "s-failed"]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(2);
  expect(stdout).toBe('{"session_id":"s-failed","state":"failed","pull_requests":[]}\n');
  expect(requests).toHaveLength(1);
});

test.concurrent("wait polls until the session is idle, silently", async () => {
  const { stdout, stderr, exitCode } = await molnet(["wait", "s-then-idle", "--interval", "1"]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  expect(stdout).toBe('{"session_id":"s-then-idle","state":"idle","pull_requests":[]}\n');
});

test.concurrent("wait exits 2 when the session fails while polling", async () => {
  const { stdout, stderr, exitCode } = await molnet(["wait", "s-then-failed", "--interval", "1"]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(2);
  expect(stdout).toBe('{"session_id":"s-then-failed","state":"failed","pull_requests":[]}\n');
});

test.concurrent("wait prints the current status and exits 3 at the timeout, after a last poll at the deadline", async () => {
  const start = Date.now();
  const { stdout, stderr, exitCode } = await molnet(["wait", "s-working", "--interval", "30", "--timeout", "1"]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(3);
  expect(stdout).toBe('{"session_id":"s-working","state":"working","pull_requests":[]}\n');
  expect(Date.now() - start).toBeLessThan(10_000); // the 30 s sleep was cut short by the deadline
  expect(requests.filter((r) => r.path === sessionPath("s-working"))).toHaveLength(2);
});

test.concurrent("wait exits with the real state when the poll at the deadline finds the session stopped", async () => {
  const { stdout, stderr, exitCode } = await molnet(["wait", "s-idle-at-deadline", "--interval", "30", "--timeout", "1"]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  expect(stdout).toBe('{"session_id":"s-idle-at-deadline","state":"idle","pull_requests":[]}\n');
  expect(requests.filter((r) => r.path === sessionPath("s-idle-at-deadline"))).toHaveLength(2);
});

test.concurrent("wait ends on an unrecognized status seen while polling", async () => {
  const { stdout, stderr, exitCode } = await molnet(["wait", "s-then-weird", "--interval", "1"]);
  expect(stdout).toBe("");
  expect(stderr).toBe("molnet: unrecognized session status sleeping/null\n");
  expect(exitCode).toBe(1);
});

test("wait fails with nothing on stdout on an unknown id, an API error or an unrecognized status", async () => {
  const cases: [string, string][] = [
    ["nope-1", "failed with 403"],
    ["s-500", "failed with 500: boom"],
    ["s-weird", "molnet: unrecognized session status sleeping/null"],
  ];
  for (const [id, error] of cases) {
    const { stdout, stderr, exitCode } = await molnet(["wait", id]);
    expect(stdout).toBe("");
    expect(stderr).toContain(error);
    expect(exitCode).toBe(1);
  }
});

test("wait validates input before calling the API", async () => {
  const cases: [string[], string][] = [
    [["wait"], "wait requires a session id"],
    [["wait", ""], "session id is empty"],
    [["wait", "  "], "session id is empty"],
    [["wait", "s-idle", "s-working"], "wait takes one session id; run one wait per session"],
    [["wait", "s-idle", "--interval", "0"], "--interval must be a positive integer, got: 0"],
    [["wait", "s-idle", "--interval", "1.5"], "--interval must be a positive integer, got: 1.5"],
    [["wait", "s-idle", "--interval", "abc"], "--interval must be a positive integer, got: abc"],
    [["wait", "s-idle", "--timeout", "0"], "--timeout must be a positive integer, got: 0"],
    [["wait", "s-idle", "--timeout=-5"], "--timeout must be a positive integer, got: -5"],
    [["wait", "s-idle", "--nope"], "Unknown option '--nope'"],
  ];
  for (const [args, error] of cases) {
    const { stdout, stderr, exitCode } = await molnet(args);
    expect(stdout).toBe("");
    expect(stderr).toContain(error);
    expect(exitCode).toBe(1);
  }
  expect(requests).toEqual([]);
});

test("wait --help prints usage and exits 0", async () => {
  for (const flag of ["--help", "-h"]) {
    const { stdout, exitCode } = await molnet(["wait", flag], { DEVIN_API_KEY: "" });
    expect(stdout).toContain("Usage: molnet wait");
    expect(exitCode).toBe(0);
  }
  expect(requests).toEqual([]);
});

test("--help prints usage and exits 0", async () => {
  const top = await molnet(["--help"]);
  expect(top.stdout).toContain("Usage: molnet <command>");
  expect(top.stdout).toContain("spawn");
  expect(top.exitCode).toBe(0);

  const spawn = await molnet(["spawn", "--help"], { DEVIN_API_KEY: "" });
  expect(spawn.stdout).toContain("Usage: molnet spawn");
  expect(spawn.exitCode).toBe(0);
  expect(requests).toEqual([]);
});

test("missing or unknown command prints usage to stderr and exits 1", async () => {
  for (const [args, message] of [[[], "missing command"], [["nope"], "unknown command: nope"]] as const) {
    const { stdout, stderr, exitCode } = await molnet([...args]);
    expect(stdout).toBe("");
    expect(stderr).toStartWith(`molnet: ${message}\n`);
    expect(stderr).toContain("Usage: molnet <command>");
    expect(exitCode).toBe(1);
  }
});

const limits: SessionStatusDetail[] = [
  "usage_limit_exceeded",
  "out_of_credits",
  "out_of_quota",
  "no_quota_allocation",
  "payment_declined",
  "org_usage_limit_exceeded",
  "user_usage_limit_exceeded",
  "total_session_limit_exceeded",
  "contract_expired",
  "error",
];

const idle: SessionStatusDetail[] = ["waiting_for_user", "waiting_for_approval", "finished"];

test("toState follows the mapping table", () => {
  expect(toState("running", null)).toBe("working");
  expect(toState("running", "working")).toBe("working");
  for (const detail of idle) {
    expect(toState("running", detail)).toBe("idle");
  }
  expect(toState("suspended", "inactivity")).toBe("idle");
  expect(toState("suspended", "user_request")).toBe("idle");
  for (const detail of limits) {
    expect(toState("suspended", detail)).toBe("failed");
  }
});

test("new, claimed, resuming, error and exit map on status alone", () => {
  const details: (SessionStatusDetail | null)[] = [null, "working", "finished", "waiting_for_user", "inactivity", "out_of_credits", "error"];
  details.push("daydreaming" as SessionStatusDetail); // outside the union
  const working: SessionStatus[] = ["new", "claimed", "resuming"];
  const failed: SessionStatus[] = ["error", "exit"];
  for (const detail of details) {
    for (const status of working) expect(toState(status, detail)).toBe("working");
    for (const status of failed) expect(toState(status, detail)).toBe("failed");
  }
});

test("a missing status_detail is treated as null", () => {
  expect(toState("running", undefined)).toBe("working");
  expect(() => toState("suspended", undefined)).toThrow("unrecognized session status suspended/null");
});

test("toState throws on combinations outside the table", () => {
  const cases: [unknown, unknown, string][] = [
    ["running", "inactivity", "running/inactivity"],
    ["running", "out_of_credits", "running/out_of_credits"],
    ["suspended", null, "suspended/null"],
    ["suspended", "working", "suspended/working"],
    ["sleeping", null, "sleeping/null"],
    ["running", "daydreaming", "running/daydreaming"],
    ["suspended", "daydreaming", "suspended/daydreaming"],
    ["constructor", null, "constructor/null"],
    ["__proto__", null, "__proto__/null"],
    ["suspended", "constructor", "suspended/constructor"],
    ["suspended", "toString", "suspended/toString"],
    [undefined, null, "undefined/null"],
    [42, null, "42/null"],
  ];
  for (const [status, detail, text] of cases) {
    expect(() => toState(status as SessionStatus, detail as SessionStatusDetail)).toThrow(new Error(`unrecognized session status ${text}`));
  }
});

const session: Session = {
  session_id: "devin-1",
  url: "https://app.devin.ai/sessions/devin-1",
  status: "suspended",
  status_detail: "out_of_credits",
  tags: ["x"],
  org_id: "org-1",
  created_at: 1,
  updated_at: 2,
  acus_consumed: 3,
  pull_requests: [
    { pr_url: "https://github.com/a/b/pull/12", pr_state: "open" },
    { pr_url: "https://github.com/a/b/pull/13", pr_state: null },
  ],
};

test("cloudAgentStatus has exactly three keys, in order", () => {
  const result = cloudAgentStatus(session);
  expect(Object.keys(result)).toEqual(["session_id", "state", "pull_requests"]);
  expect(JSON.stringify(result)).toBe(
    '{"session_id":"devin-1","state":"failed","pull_requests":["https://github.com/a/b/pull/12","https://github.com/a/b/pull/13"]}',
  );
});

test("cloudAgentStatus keeps every key when there is nothing to report", () => {
  const { status_detail, ...rest } = session;
  const result = cloudAgentStatus({ ...rest, status: "running", pull_requests: [] });
  expect(JSON.stringify(result)).toBe('{"session_id":"devin-1","state":"working","pull_requests":[]}');
});

test("cloudAgentStatus throws on an unrecognized status", () => {
  expect(() => cloudAgentStatus({ ...session, status: "running", status_detail: "inactivity" })).toThrow(
    "unrecognized session status running/inactivity",
  );
});
