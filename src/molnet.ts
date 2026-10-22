#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { createDevinSessionsClient, type DevinMode } from "./devin.ts";

type Command = (args: string[]) => void | Promise<void>;

const devinModes: readonly DevinMode[] = ["normal", "fast", "fusion", "lite", "ultra", "swe-2-medium", "swe-2-high", "swe-2-max"];

const spawnUsage = `Usage: molnet spawn [options] <prompt>

Creates a Devin session and prints {"session_id","url","status"} as JSON.
Omitted options are not sent, so API/organization defaults apply.
Quote the prompt; use "--" before a prompt that starts with "-".

Options:
  --max-acu-limit <n>           Max ACUs the session may consume (positive integer)
  --devin-mode <mode>           ${devinModes.join(", ")}
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

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(`molnet: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
