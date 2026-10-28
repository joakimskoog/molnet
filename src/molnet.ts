#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { createDevinSessionsClient, type DevinMode, type Session, type SessionStatus, type SessionStatusDetail } from "./devin.ts";

type Command = (args: string[]) => void | Promise<void>;

const devinModes: readonly DevinMode[] = ["normal", "fast", "fusion", "lite", "ultra", "swe-2-medium", "swe-2-high", "swe-2-max"];

type State = "working" | "idle" | "failed";

interface CloudAgentStatus {
  session_id: string;
  state: State;
  pull_requests: string[];
}

const failureDetails: ReadonlySet<SessionStatusDetail | null> = new Set([
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
]);

/** Maps Devin's `status`/`status_detail` to molnet's `state`. The types cover the documented values; undocumented ones still reach the switch at runtime and throw. */
export function toState(status: SessionStatus, statusDetail: SessionStatusDetail | null | undefined): State {
  const detail = statusDetail ?? null; // a missing key counts as null
  switch (status) {
    case "new":
    case "claimed":
    case "resuming":
      return "working";
    case "running":
      if (detail === null || detail === "working") return "working";
      if (detail === "waiting_for_user" || detail === "waiting_for_approval" || detail === "finished") return "idle";
      break;
    case "suspended":
      if (detail === "inactivity" || detail === "user_request") return "idle";
      if (failureDetails.has(detail)) return "failed";
      break;
    case "error":
    case "exit":
      return "failed";
  }
  throw new Error(`unrecognized session status ${status}/${detail}`);
}

export function cloudAgentStatus(session: Session): CloudAgentStatus {
  return {
    session_id: session.session_id,
    state: toState(session.status, session.status_detail),
    pull_requests: session.pull_requests.map((pr) => pr.pr_url),
  };
}

const spawnUsage = `Usage: molnet spawn [options] <prompt>

Creates a Devin session and prints {"session_id","url","status"} as JSON.
Omitted options are not sent, so API/organization defaults apply.
Quote the prompt; use "--" before a prompt that starts with "-".

Options:
  --max-acu-limit <n>           Max ACUs the session may consume (positive integer)
  --devin-mode <mode>           ${devinModes.join(", ")}
  -h, --help                    Show this help`;

const statusUsage = `Usage: molnet status <id>...

Prints one JSON line per session: {"session_id","state","pull_requests"}.
Lines follow the order of the ids; a repeated id is printed once.
Fails with nothing on stdout if any lookup fails.

Options:
  -h, --help                    Show this help`;

const commands: Record<string, Command> = {
  spawn: async (args) => {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        "max-acu-limit": { type: "string" },
        "devin-mode": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
    if (values.help) return console.log(spawnUsage);

    if (positionals.length !== 1) {
      throw new Error(`spawn requires exactly one prompt argument (quote it), got ${positionals.length}`);
    }
    const prompt = positionals[0]!;
    if (!prompt.trim()) throw new Error("Prompt is empty");

    const maxAcuLimit = values["max-acu-limit"];
    if (maxAcuLimit !== undefined && !/^[1-9]\d*$/.test(maxAcuLimit)) {
      throw new Error(`--max-acu-limit must be a positive integer, got: ${maxAcuLimit}`);
    }

    const devinMode = values["devin-mode"] as DevinMode | undefined;
    if (devinMode !== undefined && !devinModes.includes(devinMode)) {
      throw new Error(`--devin-mode must be one of ${devinModes.join(", ")}, got: ${devinMode}`);
    }

    const session = await createDevinSessionsClient().createSession({
      prompt,
      max_acu_limit: maxAcuLimit === undefined ? undefined : Number(maxAcuLimit),
      devin_mode: devinMode,
    });
    console.log(JSON.stringify({ session_id: session.session_id, url: session.url, status: session.status }));
  },
  status: async (args) => {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: { help: { type: "boolean", short: "h" } },
    });
    if (values.help) return console.log(statusUsage);

    if (positionals.length === 0) throw new Error("status requires at least one session id");
    if (positionals.some((id) => !id.trim())) throw new Error("session id is empty");
    const ids = [...new Set(positionals)];

    const client = createDevinSessionsClient();
    const sessions = await Promise.all(ids.map((id) => client.getSession(id)));

    // Build every line before printing, so one unrecognized status leaves stdout empty.
    const lines = sessions.map((session) => JSON.stringify(cloudAgentStatus(session)));
    console.log(lines.join("\n"));
  },
};

const usage = `Usage: molnet <command> [options]

Commands:
${Object.keys(commands).map((name) => `  ${name}`).join("\n")}

Run 'molnet <command> --help' for command options.`;

async function main([name, ...args]: string[]): Promise<number> {
  if (name === "-h" || name === "--help") {
    console.log(usage);
    return 0;
  }
  const command = name ? commands[name] : undefined;
  if (!command) {
    console.error(`${name ? `Unknown command: ${name}` : "Missing command"}\n\n${usage}`);
    return 1;
  }
  await command(args);
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`molnet: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
