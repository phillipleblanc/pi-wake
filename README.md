# pi-wake

A [pi](https://pi.dev) extension that adds a `/wake` command and model-callable `wake` tool for scheduling future user messages in the current session.

This is useful when an agent starts a long-running background job (for example, a build or test run in tmux) and should check back later without blocking the foreground `bash` tool with `sleep`.

## Install

```bash
pi install git:github.com/phillipleblanc/pi-wake
```

Reload or restart pi after installation:

```text
/reload
```

## Usage

Schedule a wake-up message:

```text
/wake 2m
/wake 1h30s check the tmux build output
/wake 30s continue debugging the failed test
```

If no message is provided, pi sends `continue`.

Durations support `ms`, `s`, `m`, `h`, and `d`, including combined forms such as `1h30m`, `1h30s`, or `1h 30m`.

## Commands

```text
/wake <duration> [message]  Schedule a future user message
/wake list                  List active wake jobs
/wake cancel [message]      Cancel the wake job for a message; defaults to "continue"
/wake clear                 Cancel all wake jobs
```

Multiple wake jobs can be active at once, keyed by message. Scheduling the same message replaces the previous job for that message:

```text
/wake 2m
/wake 5m
```

The second command replaces the first because both use the default `continue` message.

## Model tool

The extension also registers an LLM-callable tool named `wake` with this shape:

```json
{
  "duration": "2m",
  "message": "check tmux build"
}
```

Tool guidance tells the model to use `wake` when waiting for long-running background jobs instead of calling `sleep` in the foreground `bash` tool.

## Footer

When a wake job is active, the existing pi footer shows the next wake after context usage:

```text
36.7%/400k (auto) • next wake: 10s
```

The countdown refreshes about every 10 seconds while wake jobs are active.

## Notes

Wake jobs are session-scoped and run while the pi process is alive. They are restored from the current session branch on reload or session-tree navigation when possible.
