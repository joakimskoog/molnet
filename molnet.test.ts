import { afterAll, beforeEach, expect, test } from "bun:test";

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
