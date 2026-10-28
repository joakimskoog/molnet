## molnet

It reads `DEVIN_API_KEY`, `DEVIN_ORG_ID` and, optionally, `DEVIN_API_URL` from the environment.

```sh
bun src/molnet.ts spawn "Fix the failing tests" --max-acu-limit 5
bun src/molnet.ts spawn "Refactor the parser" --devin-mode fast
bun src/molnet.ts spawn -- "-starts with a dash"
bun src/molnet.ts status 7a8b9c0d1e2f43a5b6c7d8e9f0a1b2c3 0c1d2e3f4a5b46789abcdef012345678
bun src/molnet.ts --help          # list commands
bun src/molnet.ts spawn --help    # spawn options
bun src/molnet.ts status --help   # status usage
```

It also runs with `node src/molnet.ts ...`. Running `bun link` installs it as `molnet` on your PATH. The exit code is 0 on success. Invalid arguments, API errors and missing credentials print `molnet: <message>` to stderr and exit 1. To add a command, add an entry to `commands` in `src/molnet.ts`.

### `spawn`

Creates a Devin session and prints one line of JSON: `{"session_id": "...", "url": "...", "status": "..."}`. Options you leave out are not sent, so API and organization defaults apply.

| Option | API field |
| - | - |
| `<prompt>`: required positional argument. Quote it, because more than one positional argument is an error. Put `--` before a prompt that starts with `-`. | `prompt` |
| `--max-acu-limit <n>` (positive integer) | `max_acu_limit` |
| `--devin-mode <mode>` (checked locally against known modes) | `devin_mode` |

### `status`

Prints one line of JSON per session: `{"session_id": "...", "state": "working" | "idle" | "failed", "pull_requests": ["..."]}`. `molnet status <id>...` takes one or more session IDs, looks each up once (in parallel), and prints the lines in the order the IDs were given. A repeated ID is printed once. An empty ID is rejected without calling the API.

The command prints nothing and exits 1 if any lookup fails (an unknown ID is one kind of failure; no retries), or if a session has a status molnet doesn't recognize. Otherwise it exits 0: the outcome is in `state`, not the exit code.

## Development

```sh
bun install
bun test
bun run typecheck
```
