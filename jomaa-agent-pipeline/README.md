# jomaa-agent-pipeline

Every code change in this repository goes through a blind pipeline. The change
is written as a product instruction, reviewed so it's complete and gives no
recipe, and judged by hidden tests written before the code. Those tests reach
the implementing agent only as a pass or fail per requirement. The main agent
follows [SKILL.md](SKILL.md); settings are in [config.md](config.md).

```
plan ─▶ instruction review ─▶ refactor + hidden tests ─▶ test review ─▶ seal ─▶ blind implementation ─▶ evaluate ─▶ audit ─▶ land
```

## Files

| File | What it is |
| --- | --- |
| `SKILL.md` | The orchestrator's procedure. |
| `prompts/*.md` | The premade system prompts of the four agent roles. |
| `pipeline.py` | Starts each agent headless, seals and evaluates the tests, and lands the change. |
| `scope.py` | The workspace boundary: which tool calls stay inside an agent's workspace. |
| `guard.py` | The PreToolUse hook that applies the boundary to every agent. |
| `anticheat.py` | Audits an implementer's trajectory for escapes and leaked secrets. |

## Tests before and after

The test author writes two kinds of tests, listed in a manifest with one
command per test:

- `fail_to_pass` tests fail on the base and pass once the requirement is met;
- `pass_to_pass` tests pass on the base and must keep passing.

`seal` runs them on the base, refactor included, and refuses to seal unless
every one behaves as its kind says, `sealRuns` times in a row. `evaluate` runs
the same sealed bytes, checked against their SHA-256, on the implementation.
The tests are black boxes: they touch only the instruction's Contract and
interfaces that already exist, so nothing in them has to change for them to
pass.

When the base offers no way to test a requirement from outside, the author
first refactors it. The refactor preserves behavior and has nothing to do with
the feature, and the test reviewer checks both. The refactor becomes part of
the implementer's base.

## How the implementer is kept blind

- **Nothing to find in its workspace.** Every agent works in a fresh
  `git archive` export of the base under `workspaceDir`, with one commit and no
  history, remotes, or other branches. Future commits and the main checkout
  are not in it.
- **Tests encrypted at rest.** `seal` encrypts the tests with a random 32-byte
  key, using a SHAKE-256 keystream and an HMAC-SHA256 tag. It deletes the
  author's workspace and prints the key once to the orchestrator. Without the
  key the bundle in `stateDir` is opaque, and the tag detects any change to it.
- **No transcripts of the tests.** The test author and both reviewers run with
  `--no-session-persistence`, and `pipeline.py` keeps only their final
  messages. Claude Code can still spill a large tool output to disk, so `seal`
  deletes the author workspace's folder under `claudeProjectsDir`. Only the
  implementer's session is recorded.
- **Confined tools.** Agents run `claude -p --restricted`: the file tools work
  only inside the workspace, user and project settings, MCP servers and skills
  are off, and each role has a fixed tool list without web or subagent tools.
  `guard.py` runs before every tool call. It denies paths outside the
  workspace and `systemPaths`, `~` and variables such as `$HOME` or `$TMPDIR`,
  network commands, URLs, and tools outside the role.
- **Audited afterwards.** The guard reads command text, so a determined
  agent could build a path it can't see. `anticheat.py` therefore reads the
  whole recorded trajectory. It flags every call that left the boundary,
  blocked or not. It flags every tool result that contains a line of a hidden
  test, the per-seal canary comment, or a line from a `--forbid` file that the
  agent had not written itself. Lines that also appear in the base are not
  secrets.
- **Feedback carries no test content.** The implementer only ever learns the
  numbers of unmet requirements.

## Running the anti-cheat check on its own

```bash
python3 jomaa-agent-pipeline/anticheat.py <trajectory.jsonl>... \
  --workspace <implementer workspace> --tools Bash,Read,Edit,Write,Glob,Grep \
  [--secrets <file>...] [--json]
```

It accepts `--output-format stream-json` output and Claude Code session
transcripts, prints one line per finding, and exits 1 when there is an
`escape` or a `leak`.

## Reproducing a past change

To check the pipeline against a change whose answer is known, start a task at
the change's parent commit (`--base <sha>^`) with an instruction written from
its commit message, run the pipeline, and audit with the lines the change
added as a forbidden file:

```bash
git show --format= <sha> | grep '^+' | grep -v '^+++' | cut -c2- > <dir>/original.txt
pipeline.py audit <task> --key <hex> --forbid <dir>/original.txt
```

The implementer's workspace holds only the parent, so a tool result that
contains a line of the original change, one the implementer had not written
itself and that is not already in the parent, means it escaped.
