#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { createDevinSessionsClient, type DevinMode, type Session, type SessionStatus, type SessionStatusDetail } from "./devin.ts";

/** Returns the process exit code; returning nothing means 0. */
type Command = (args: string[]) => number | void | Promise<number | void>;

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

const waitUsage = `Usage: molnet wait [options] <id>

Polls the session until its state is not "working", then prints
{"session_id","state","pull_requests"}. Silent while polling.
The first poll is immediate; it fails with nothing on stdout if any poll fails.

Exit codes: 0 idle, 1 error, 2 failed, 3 timeout (state still "working").

Options:
  --interval <seconds>          Poll every <seconds> (positive integer, default 30)
  --timeout <seconds>           Give up after <seconds> (positive integer, default none)
  -h, --help                    Show this help`;

const maxSleepMs = 2 ** 31 - 1; // longer timers overflow and fire after 1 ms

const waitExitCodes: Record<State, number> = { idle: 0, failed: 2, working: 3 };

/** Parses a flag value as a positive integer, or undefined if the flag is absent. */
function positiveInteger(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`--${name} must be a positive integer, got: ${value}`);
  return Number(value);
}

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

    const maxAcuLimit = positiveInteger("max-acu-limit", values["max-acu-limit"]);

    const devinMode = values["devin-mode"] as DevinMode | undefined;
    if (devinMode !== undefined && !devinModes.includes(devinMode)) {
      throw new Error(`--devin-mode must be one of ${devinModes.join(", ")}, got: ${devinMode}`);
    }

    const session = await createDevinSessionsClient().createSession({
      prompt,
      max_acu_limit: maxAcuLimit,
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
  wait: async (args) => {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        interval: { type: "string" },
        timeout: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
    if (values.help) return console.log(waitUsage);

    if (positionals.length === 0) throw new Error("wait requires a session id");
    if (positionals.length > 1) throw new Error("wait takes one session id; run one wait per session");
    const id = positionals[0]!;
    if (!id.trim()) throw new Error("session id is empty");
    const interval = positiveInteger("interval", values.interval) ?? 30;
    const timeout = positiveInteger("timeout", values.timeout);

    const client = createDevinSessionsClient();
    const deadline = timeout === undefined ? Infinity : performance.now() + timeout * 1000;
    let last = false; // decided before sleeping, because timers can fire a little early
    while (true) {
      const status = cloudAgentStatus(await client.getSession(id));
      const remaining = deadline - performance.now();
      // The poll at the deadline is the last one: print whatever it saw.
      if (status.state !== "working" || last || remaining <= 0) {
        console.log(JSON.stringify(status));
        return waitExitCodes[status.state];
      }
      const sleepMs = Math.min(interval * 1000, remaining, maxSleepMs);
      last = sleepMs === remaining;
      await sleep(sleepMs);
    }
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
    console.error(`molnet: ${name ? `unknown command: ${name}` : "missing command"}\n\n${usage}`);
    return 1;
  }
  return (await command(args)) ?? 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`molnet: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
