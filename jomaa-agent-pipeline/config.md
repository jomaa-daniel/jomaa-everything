# jomaa-agent-pipeline configuration

`config.json` is read by `pipeline.py`, `scope.py`, `guard.py` and
`anticheat.py`. A test fails when a setting is missing from this document.

| Key | Type | Meaning |
| --- | --- | --- |
| `stateDir` | path | Where task state lives: the instruction, reviews, sealed tests, patches, trajectories, evaluations and audits. `~` is the home directory. |
| `workspaceDir` | path | Where the agents' history-free workspaces are exported, one folder per task. Outside the repository and `stateDir`. |
| `claudeProjectsDir` | path | Where Claude Code keeps each working directory's sessions and spilled tool output. `seal` deletes the author workspace's folder there, and `clean` deletes every task workspace's. |
| `claude` | paths | Claude Code executables to try in order; the first one found starts the agents. On machines whose `claude` launcher wraps itself in a macOS sandbox, the native binary goes first so agents can start from inside another session. |
| `clearEnvironment` | names | Environment variables removed before starting an agent or a test, so an agent started from inside a Claude Code session doesn't inherit that session's identity, messaging socket or sandbox wrapper. |
| `roles` | object | One entry per agent role; the role name is also its prompt file in `prompts/`. |
| `roles.<role>.model` | model | Model alias or full name passed to `--model`. |
| `roles.<role>.effort` | level | Reasoning effort passed to `--effort`. |
| `roles.<role>.tools` | names | The role's only tools. The guard denies any other tool. |
| `roles.<role>.budgetUsd` | dollars | Spending cap of one session, passed to `--max-budget-usd`. |
| `roles.<role>.persist` | boolean | Whether the session is saved. Only the implementer's is, so it can be resumed with feedback and audited; sessions that see the hidden tests leave no transcript. |
| `systemPaths` | paths | Directories outside the workspace that an agent may name, such as interpreters and toolchains. Nothing in them may hold repository content, task state or transcripts. |
| `prepare` | object | Commands that make a component folder runnable in a fresh export, keyed by folder, such as installing dependencies. They run for the folders named by `start --components`. |
| `feedbackRounds` | count | How many times the implementer may be resumed with unmet requirements. |
| `sealRuns` | count | How many times `seal` runs every hidden test on the base; each run must agree with the tests' kinds. |
| `testTimeoutSeconds` | seconds | Deadline for one setup step or one hidden test. |
| `agentTimeoutSeconds` | seconds | Deadline for one agent session, in wall-clock time, so time the computer spends asleep counts. |
| `agentWatchSeconds` | seconds | How often a running agent session is checked against its deadline. |
| `secretLineLength` | characters | Shortest stripped line of a hidden test or forbidden file that the audit looks for in tool results. |
