# jomaa-agent-pipeline

The blind pipeline is optional and runs only when explicitly requested. It is
an unattended job: `pipeline.py run` is the parent of every agent. It
dispatches each agent with one role and a bounded objective, validates what
the agent returns, and decides every next step itself. No agent chooses what
happens next or starts another agent. A change is written as a product
instruction, reviewed so it's complete and gives no recipe, and judged by
hidden tests written before the code. Those tests reach the implementing
agents only as a pass or fail per requirement. Settings are in
[config.md](config.md); a chat agent follows [SKILL.md](SKILL.md).

```
instruction ─▶ instruction review ─▶ refactor + hidden tests ─▶ test review ─▶ seal
  ─▶ N blind implementers ─▶ evaluate + audit ─▶ select ─▶ pull request ─▶ CI ─▶ merge ─▶ deploy
```

## Running a job

```bash
python3 jomaa-agent-pipeline/pipeline.py run <task> --instruction <file> [--base <rev>] [--components <folder> ...]
python3 jomaa-agent-pipeline/pipeline.py run <task> --change <rev | from..to>
python3 jomaa-agent-pipeline/pipeline.py status <task>
python3 jomaa-agent-pipeline/pipeline.py clean <task>
```

- **From an instruction**: build a new change on `--base`, the tip of
  `landBranch` by default. `--components` names the folders whose `prepare`
  steps run.
- **From a change**: rebuild a change that already landed, as a refactoring
  bot. `<rev>` means the change from its first parent to it. The change must
  be reachable from `landBranch`. A `spec-writer` describes it as an
  instruction; it is rebuilt blind on its parent; the original serves as the
  answer key for the hidden tests; and the rebuild replaces the original.

A job takes hours. Start it in the background and leave it:

```bash
nohup python3 jomaa-agent-pipeline/pipeline.py run <task> --change <rev> > <log> 2>&1 &
```

It keeps the computer awake with `keepAwake` while it runs. `status` prints
the current stage and every dispatch, with its role, attempt, round, outcome
and cost. Ctrl-C or SIGTERM stops every agent session and command and ends
the job as failed and interrupted.

Before any agent runs, `run` fetches `landBranch` from `landRemote` and
refuses a task that exists, a revision that doesn't resolve, a missing
instruction file, and for a change, a range whose start is not an ancestor of
its end, whose end is not on the landing branch, or that touches no file.

## Roles

| Role | Objective | Prompt holds | Workspace |
| --- | --- | --- | --- |
| `spec-writer` | describe a landed change as a product instruction | where the change's commit messages and diff are; on revise, the previous instruction and the findings | export of the change's tip, with the commit messages and diff in `.blind/change/` |
| `instruction-reviewer` | approve the instruction or say what to revise | the instruction | export of the base |
| `test-author` | refactor if needed, then write the hidden tests and manifest | the instruction; on revise, the findings | export of the base |
| `test-reviewer` | approve the tests and refactor or say what to revise | the instruction | the test author's workspace |
| `implementer` | implement the instruction | the instruction; when resumed, only the unmet requirement numbers | its attempt's own export of the base plus the refactor |

Each session has its role's prompt from [`prompts/`](prompts), its tools, the
guard hook, and limits on budget (`budgetUsd`), model turns (`maxTurns`) and
wall-clock time (`agentTimeoutSeconds`). It returns a structured response
that must match its role's JSON Schema in [`schemas/`](schemas), with
`"schema": "jomaa-pipeline.<role>.v1"`. A session that crashes, runs out of
budget, turns or time, or returns a response that doesn't match is a failed
dispatch and runs again as a new session, up to `dispatchRetries` more times.
After that, an implementer attempt is disqualified and any other role fails
its stage. Once the job's cost reaches `maxCostUsd`, no further dispatch
starts.

## Stages

1. **instruction.** From an instruction file, one review; `revise` ends the
   job, and the report holds the findings for the owner to address. From a
   change, each `revise` goes back to a new spec-writer with the findings, up
   to `reviewRounds` reviews.
2. **tests.** The test author writes the refactor, the tests and
   `.blind/manifest.json`; the test reviewer reviews them; each `revise` goes
   back to the author, up to `reviewRounds` reviews. Approved tests are
   checked in a fresh export of the author's work, `sealRuns` times: each
   `fail_to_pass` must fail and each `pass_to_pass` must pass. From a change,
   every test must also pass on the original with the refactor applied. A
   failed check goes back to the author as findings and uses a review round.
   Sealing encrypts the tests with a key that lives only in the job's memory,
   saves the refactor, and deletes the author's workspace and sessions.
3. **implement.** `attempts` implementers work at most `parallelAttempts` at a
   time, each in its own export and blind to the others. Each attempt is
   evaluated against the sealed tests and resumed up to `feedbackRounds`
   times with only its unmet requirement numbers, then audited. The
   qualifying attempt (every test passes, the audit passes) whose patch adds
   the fewest lines is selected.
4. **land.** In a detached worktree at the fetched tip of `landBranch`, the
   replacement (base plus refactor, selected implementation and tests without
   the canary, as a diff from the base, or from a change's tip) is applied with
   a three-way merge. `landChecks` run, the result is committed with the
   owner's git identity, pushed to `pullRequestBranch`, and opened as a pull
   request by `openPullRequest`. The owner's branches and working tree are
   untouched.
5. **ci, merge, deploy.** `waitForChecks` waits for CI; a failure leaves the
   pull request open. `mergePullRequest` merges it, and `deployCheck` waits
   for the deploy of the merge commit. The defaults in [`github.py`](github.py)
   use the GitHub CLI.

## The report

Every job writes `reports/<task>.json` under `stateDir`, which survives
`clean`, and `run` exits 0 only when the outcome is `landed`:

| Field | Meaning |
| --- | --- |
| `task`, `mode` | the task name; `instruction` or `change` |
| `base`, `tip` | full hashes; `tip` is null from an instruction |
| `outcome`, `stage` | `landed` with stage null, or `failed` at `instruction`, `tests`, `implement`, `land`, `ci`, `merge` or `deploy` |
| `interrupted` | whether a signal stopped the job |
| `findings` | the last review's findings when the job failed at `instruction` or `tests` |
| `dispatches` | each dispatch's `role`, `attempt` (null outside implementers), `round`, `outcome` (`ok` or `failed`) and `costUsd` |
| `costUsd` | the sum of the reported dispatch costs |
| `attempts` | each attempt's `number`, `passed`, `audit` and `addedLines` |
| `selected`, `pullRequest`, `commit`, `deploy` | the selected attempt, the pull request URL, the merge commit, and `succeeded` or `failed` |

When a job ends, every workspace, the landing worktree and what Claude Code
kept of their sessions are deleted. A landed task is deleted too; a failed
task stays under `stateDir/tasks/<task>` with its logs, reviews, patches,
evaluations and audits until `clean`.

## Files

| File | What it is |
| --- | --- |
| `pipeline.py` | The job: stages, sealing, evaluation, landing, report. |
| `agents.py` | Bounded agent sessions, response schemas, and the job's child processes. |
| `github.py` | The default pull request, checks, merge and deploy commands. |
| `prompts/*.md` | The premade system prompts of the five roles. |
| `schemas/*.json` | The JSON Schema of each role's response. |
| `scope.py` | The workspace boundary: which tool calls stay inside an agent's workspace. |
| `guard.py` | The PreToolUse hook that applies the boundary to every agent. |
| `anticheat.py` | Audits an implementer's trajectory for escapes and leaked secrets. |

## How the implementers are kept blind

- **Nothing to find in the workspace.** Every agent works in a fresh
  `git archive` export under `workspaceDir`, with one commit and no history,
  remotes, or other branches. Implementers get the base, never the change's
  tip or another attempt's work.
- **Tests encrypted at rest.** Sealing encrypts the tests with a random 32-byte
  key, using a SHAKE-256 keystream and an HMAC-SHA256 tag, and deletes the
  author's workspace. The key exists only in the job's memory: it is never
  printed, logged, written or put in a prompt.
- **No transcripts of the tests or the original.** The spec writer, test
  author and reviewers run with `--no-session-persistence`, and the job keeps
  only their structured responses. Sealing and the end of the job delete their
  workspaces' folders under `claudeProjectsDir`, where Claude Code can spill
  large tool output. Only implementer sessions are recorded.
- **Confined tools.** Agents run `claude -p --restricted`: the file tools work
  only inside the workspace, user and project settings, MCP servers and skills
  are off, and each role has a fixed tool list without web or subagent tools.
  `guard.py` runs before every tool call. It denies paths outside the
  workspace and `systemPaths`, `~` and variables such as `$HOME` or `$TMPDIR`,
  network commands, URLs, and tools outside the role.
- **Audited afterwards.** The guard reads command text, so a determined agent
  could build a path it can't see. `anticheat.py` reads every recorded
  implementer trajectory. It flags every call that left the boundary, blocked
  or not, and every tool result that contains a line of a hidden test, the
  per-seal canary comment, or, from a change, a line the original change
  added, unless the agent wrote it itself or the base already has it. A failed
  audit disqualifies the attempt whatever the tests say.
- **Feedback carries no test content.** An implementer only ever learns the
  numbers of unmet requirements.

## Running the anti-cheat check on its own

```bash
python3 jomaa-agent-pipeline/anticheat.py <trajectory.jsonl>... \
  --workspace <implementer workspace> --tools Bash,Read,Edit,Write,Glob,Grep,StructuredOutput \
  [--secrets <file>...] [--json]
```

It accepts `--output-format stream-json` output and Claude Code session
transcripts, prints one line per finding, and exits 1 when there is an
`escape` or a `leak`.
