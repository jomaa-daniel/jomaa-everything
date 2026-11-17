# jomaa-agent-pipeline configuration

`config.json` is read by `pipeline.py`, `agents.py`, `scope.py`, `guard.py`,
`anticheat.py` and `github.py`. A test fails when a setting is missing from
this document.

## Agents

| Key | Type | Meaning |
| --- | --- | --- |
| `stateDir` | path | Where task state lives (instruction, sealed tests, patches, trajectories, evaluations, audits, logs) under `tasks/`, and job reports under `reports/`. `~` is the home directory. |
| `workspaceDir` | path | Where the agents' history-free workspaces and the landing checkout are made, one folder per task. Outside the repository and `stateDir`. |
| `claudeProjectsDir` | path | Where Claude Code keeps each working directory's sessions and spilled tool output. Sealing deletes the author workspace's folder there, and the end of a job and `clean` delete every task workspace's. |
| `claude` | paths | Claude Code executables to try in order; the first one found starts the agents. On machines whose `claude` launcher wraps itself in a macOS sandbox, the native binary goes first so agents can start from inside another session. |
| `clearEnvironment` | names | Environment variables removed before starting an agent or a command, so an agent started from inside a Claude Code session doesn't inherit that session's identity, messaging socket or sandbox wrapper. |
| `roles` | object | One entry per agent role; the role name is also its prompt file in `prompts/` and its response schema in `schemas/`. |
| `roles.<role>.model` | model | Model alias or full name passed to `--model`. |
| `roles.<role>.effort` | level | Reasoning effort passed to `--effort`. |
| `roles.<role>.tools` | names | The role's only tools, besides the one that returns its structured response. The guard denies any other tool. |
| `roles.<role>.budgetUsd` | dollars | Spending cap of one session, passed to `--max-budget-usd`. |
| `roles.<role>.persist` | boolean | Whether the session is saved. Only the implementer's is, so it can be resumed with feedback and audited; sessions that see the hidden tests or the original change leave no transcript. |
| `roles.<role>.maxTurns` | count | Most model turns in one session; a session that goes past it is stopped and counts as a failed dispatch. |
| `systemPaths` | paths | Directories outside the workspace that an agent may name, such as interpreters and toolchains. Nothing in them may hold repository content, task state or transcripts. |
| `prepare` | object | Commands that make a component folder runnable in a fresh export, keyed by folder, such as installing dependencies. They run for the folders given with `--components`, or for a change, the folders it touches. |
| `agentTimeoutSeconds` | seconds | Deadline for one agent session, in wall-clock time, so time the computer spends asleep counts. |
| `agentWatchSeconds` | seconds | How often a running agent session is checked against its deadline. |

## The job

| Key | Type | Meaning |
| --- | --- | --- |
| `reviewRounds` | count | Most instruction reviews, and most test reviews, in one job. A seal check that fails also uses a test review. |
| `dispatchRetries` | count | How many more times a failed dispatch (crash, budget, turns, time, or a response that doesn't match its schema) runs as a new session. |
| `maxCostUsd` | dollars | Job cost at which no further dispatch starts. A dispatch that reported no cost counts its role's `budgetUsd`. |
| `sealRuns` | count | How many times every hidden test runs on the base, and for a change on the original, before sealing; each run must agree. |
| `attempts` | count | Independent blind implementer attempts per job. |
| `parallelAttempts` | count | Most implementer attempts running at the same time. |
| `feedbackRounds` | count | How many times an attempt is resumed with its unmet requirement numbers. |
| `testTimeoutSeconds` | seconds | Deadline for one prepare step, setup step, hidden test, land check, or pull request command. |
| `secretLineLength` | characters | Shortest stripped line of a hidden test or of the original change that the audit looks for in tool results. |
| `keepAwake` | argv | Command started for the length of a job to keep the computer awake; `{pid}` is the job's process id. Empty to start nothing. |

## Landing

| Key | Type | Meaning |
| --- | --- | --- |
| `landRemote` | remote | Git remote name or URL the job fetches from and pushes to. |
| `landBranch` | branch | Branch on the landing remote that an instruction is based on by default, a change must be reachable from, and pull requests target. |
| `landGitConfig` | settings | `key=value` git settings passed with `-c` to every fetch and push of the landing remote, such as a credential helper. |
| `landChecks` | argv list | Commands run in the landing checkout before committing; any nonzero exit stops the job. `{python}` is the Python interpreter. |
| `pullRequestBranch` | name | Branch the commit is pushed to; `{task}` is the task name. |
| `openPullRequest` | argv | Opens the pull request. `{branch}`, `{base}` (the landing branch), `{title}` and `{bodyFile}` are replaced; the last line it prints is the pull request URL. `{python}` is the interpreter and `{pipeline}` this folder, in this and the commands below. |
| `waitForChecks` | argv | Waits for the checks of `{pullRequest}`; exit 0 when every one passed. |
| `checksTimeoutSeconds` | seconds | Deadline for `waitForChecks` and for `mergePullRequest`. |
| `mergePullRequest` | argv | Merges `{pullRequest}`; the last line it prints is the merge commit's hash. |
| `deployCheck` | argv | Waits for the deploy of `{commit}`; exit 0 when it succeeded. |
| `deployTimeoutSeconds` | seconds | Deadline for `deployCheck`. |
| `github` | object | Settings of `github.py`, the default pull request, checks, merge and deploy commands. |
| `github.gh` | executable | The GitHub CLI. |
| `github.pollSeconds` | seconds | How often checks and workflow runs are polled. |
| `github.mergeMethod` | flag | Merge method flag passed to `gh pr merge`. |
| `github.deployWorkflow` | file | Workflow whose push run deploys the merge commit. |
| `github.deployJob` | name | Job of that workflow that must succeed. |
