import { afterAll, beforeEach, expect, test } from "bun:test";
import { toState, cloudAgentStatus } from "./src/molnet";
import type { Session, SessionStatus, SessionStatusDetail } from "./src/types";

type Request = { method: string; path: string; auth: string | null; body: any };
let requests: Request[] = [];
beforeEach(() => (requests = []));

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const body: any = await req.json();
    requests.push({ method: req.method, path: new URL(req.url).pathname, auth: req.headers.get("authorization"), body });
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
  for (const args of [[], ["nope"]]) {
    const { stdout, stderr, exitCode } = await molnet(args);
    expect(stdout).toBe("");
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
