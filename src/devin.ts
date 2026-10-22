import type {
  CreateSessionRequest,
  GenerateInsightsResponse,
  ListMessagesParams,
  ListSessionsParams,
  Page,
  SendMessageRequest,
  Session,
  SessionAttachment,
  SessionInsights,
  SessionMessage,
} from "./types";

export type * from "./types";

export interface DevinClientOptions {
  /** Service user / personal access token (`cog_...`). Defaults to `DEVIN_API_KEY`. */
  apiKey?: string;
  /** Organization ID (`org-...`). Defaults to `DEVIN_ORG_ID`. */
  orgId?: string;
  /** Defaults to `DEVIN_API_URL`, then `https://api.devin.ai`. */
  baseUrl?: string;
}

export class DevinApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(method: string, url: URL, status: number, body: string) {
    super(`${method} ${url.pathname} failed with ${status}: ${body}`);
    this.name = "DevinApiError";
    this.status = status;
    this.body = body;
  }
}

export type DevinSessionsClient = ReturnType<typeof createDevinSessionsClient>;

export function createDevinSessionsClient({
  apiKey = process.env.DEVIN_API_KEY,
  orgId = process.env.DEVIN_ORG_ID,
  baseUrl = process.env.DEVIN_API_URL || "https://api.devin.ai",
}: DevinClientOptions = {}) {
  if (!apiKey) throw new Error("Missing apiKey (or DEVIN_API_KEY)");
  if (!orgId) throw new Error("Missing orgId (or DEVIN_ORG_ID)");

  const root = `${baseUrl.replace(/\/+$/, "")}/v3/organizations/${encodeURIComponent(orgId)}/sessions`;
  const session = (devinId: string, path = "") => `/${encodeURIComponent(devinId)}${path}`;

  async function request<T>(method: string, path: string, opts: { query?: object; body?: unknown } = {}): Promise<T> {
    const url = new URL(root + path);
    // FastAPI style: arrays become repeated keys (?tags=a&tags=b), null/undefined are omitted.
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      for (const v of [value].flat()) if (v != null) url.searchParams.append(key, String(v));
    }

    const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";

    const res = await fetch(url, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    if (!res.ok) throw new DevinApiError(method, url, res.status, await res.text());
    return (await res.json()) as T;
  }

  return {
    createSession: (body: CreateSessionRequest) => request<Session>("POST", "", { body }),
    listSessions: (params: ListSessionsParams = {}) => request<Page<Session>>("GET", "", { query: params }),
    listSessionsWithInsights: (params: ListSessionsParams = {}) =>
      request<Page<SessionInsights>>("GET", "/insights", { query: params }),
    getSession: (devinId: string) => request<Session>("GET", session(devinId)),
    terminateSession: (devinId: string, params: { archive?: boolean } = {}) =>
      request<Session>("DELETE", session(devinId), { query: params }),
    archiveSession: (devinId: string) => request<Session>("POST", session(devinId, "/archive")),
    unarchiveSession: (devinId: string) => request<Session>("POST", session(devinId, "/unarchive")),
    getSessionInsights: (devinId: string) => request<SessionInsights>("GET", session(devinId, "/insights")),
    generateSessionInsights: (devinId: string) =>
      request<GenerateInsightsResponse>("POST", session(devinId, "/insights/generate")),
    listSessionAttachments: (devinId: string) =>
      request<SessionAttachment[]>("GET", session(devinId, "/attachments")),
    getSessionTags: (devinId: string) => request<{ tags: string[] }>("GET", session(devinId, "/tags")),
    replaceSessionTags: (devinId: string, tags: string[]) =>
      request<{ tags: string[] }>("PUT", session(devinId, "/tags"), { body: { tags } }),
    appendSessionTags: (devinId: string, tags: string[]) =>
      request<{ tags: string[] }>("POST", session(devinId, "/tags"), { body: { tags } }),
    listSessionMessages: (devinId: string, params: ListMessagesParams = {}) =>
      request<Page<SessionMessage>>("GET", session(devinId, "/messages"), { query: params }),
    sendMessage: (devinId: string, body: SendMessageRequest) =>
      request<Session>("POST", session(devinId, "/messages"), { body }),
  };
}

/** Iterates every item across cursor-paginated pages. */
export async function* paginate<T, P extends { after?: string | null } | undefined>(
  listPage: (params: P) => Promise<Page<T>>,
  params?: NoInfer<P>,
): AsyncGenerator<T> {
  let after = params?.after;
  do {
    const page = await listPage({ ...params, after } as P);
    yield* page.items;
    after = page.has_next_page ? page.end_cursor : null;
  } while (after);
}
