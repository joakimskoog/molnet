import { afterEach, expect, spyOn, test } from "bun:test";
import { createDevinSessionsClient, DevinApiError, paginate } from "./src/devin";

const devin = createDevinSessionsClient({ apiKey: "cog_test", orgId: "org-1", baseUrl: "https://api.devin.ai" });
const root = "https://api.devin.ai/v3/organizations/org-1/sessions";

function mockFetch(...responses: Response[]) {
  const calls: { method?: string; url: string; body?: unknown; headers: Record<string, string> }[] = [];
  spyOn(globalThis, "fetch").mockImplementation((async (url: URL, init: RequestInit) => {
    calls.push({
      method: init.method,
      url: String(url),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      headers: init.headers as Record<string, string>,
    });
    return responses.shift() ?? Response.json({});
  }) as unknown as typeof fetch);
  return calls;
}

afterEach(() => {
  (globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.();
});

test("every endpoint uses the right method, URL and body", async () => {
  const cases: [() => Promise<unknown>, string, string, unknown?][] = [
    [() => devin.createSession({ prompt: "hi" }), "POST", root, { prompt: "hi" }],
    [() => devin.listSessions({ first: 2, tags: ["a", "b"], playbook_id: null }), "GET", `${root}?first=2&tags=a&tags=b`],
    [() => devin.listSessionsWithInsights(), "GET", `${root}/insights`],
    [() => devin.getSession("devin-1"), "GET", `${root}/devin-1`],
    [() => devin.terminateSession("devin-1", { archive: true }), "DELETE", `${root}/devin-1?archive=true`],
    [() => devin.archiveSession("devin-1"), "POST", `${root}/devin-1/archive`],
    [() => devin.unarchiveSession("devin-1"), "POST", `${root}/devin-1/unarchive`],
    [() => devin.getSessionInsights("devin-1"), "GET", `${root}/devin-1/insights`],
    [() => devin.generateSessionInsights("devin-1"), "POST", `${root}/devin-1/insights/generate`],
    [() => devin.listSessionAttachments("devin-1"), "GET", `${root}/devin-1/attachments`],
    [() => devin.getSessionTags("devin-1"), "GET", `${root}/devin-1/tags`],
    [() => devin.replaceSessionTags("devin-1", ["x"]), "PUT", `${root}/devin-1/tags`, { tags: ["x"] }],
    [() => devin.appendSessionTags("devin-1", ["y"]), "POST", `${root}/devin-1/tags`, { tags: ["y"] }],
    [() => devin.listSessionMessages("devin-1", { after: "c", first: 5 }), "GET", `${root}/devin-1/messages?after=c&first=5`],
    [() => devin.sendMessage("devin-1", { message: "go" }), "POST", `${root}/devin-1/messages`, { message: "go" }],
  ];
  const calls = mockFetch();
  for (const [call] of cases) await call();

  expect(calls.map((c) => [c.method, c.url, c.body])).toEqual(cases.map(([, method, url, body]) => [method, url, body]));
  expect(calls.every((c) => c.headers.Authorization === "Bearer cog_test")).toBe(true);
  expect(calls.map((c) => c.headers["Content-Type"] !== undefined)).toEqual(cases.map(([, , , body]) => body !== undefined));
});

test("paginate follows cursors", async () => {
  const calls = mockFetch(
    Response.json({ items: [{ session_id: "1" }, { session_id: "2" }], has_next_page: true, end_cursor: "c1" }),
    Response.json({ items: [{ session_id: "3" }], has_next_page: false, end_cursor: null }),
  );
  const sessions = await Array.fromAsync(paginate(devin.listSessions, { first: 2 }));
  expect(sessions.map((s) => s.session_id)).toEqual(["1", "2", "3"]);
  expect(calls.map((c) => c.url)).toEqual([`${root}?first=2`, `${root}?first=2&after=c1`]);
});

test("non-2xx responses throw DevinApiError with status and body", async () => {
  mockFetch(new Response('{"title":"Forbidden"}', { status: 403 }));
  const error = await devin.getSession("devin-1").catch((e) => e);
  expect(error).toBeInstanceOf(DevinApiError);
  expect(error.status).toBe(403);
  expect(error.body).toBe('{"title":"Forbidden"}');
  expect(error.message).toBe('GET /v3/organizations/org-1/sessions/devin-1 failed with 403: {"title":"Forbidden"}');
});

test("requires apiKey and orgId", () => {
  expect(() => createDevinSessionsClient({ apiKey: "", orgId: "org-1" })).toThrow("apiKey");
  expect(() => createDevinSessionsClient({ apiKey: "cog_x", orgId: "" })).toThrow("orgId");
});
