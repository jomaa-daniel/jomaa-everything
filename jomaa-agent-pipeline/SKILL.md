---
name: jomaa-agent-pipeline
description: Write code in this repository through the blind pipeline — plan a change as a product instruction, have it reviewed, have hidden fail-to-pass and pass-to-pass tests written and sealed, have a blind agent implement it, then evaluate, audit the implementer's trajectory for cheating, and land the change. Use only when the user explicitly requests the blind pipeline.
---

# The blind pipeline

This pipeline is dormant by default. Run it only when the user explicitly requests it.

You are the orchestrator. You plan the change with the user, then drive three
agents through `pipeline.py`, each started headless with its premade prompt
from [`prompts/`](prompts):

| Step | Agent | Sees |
| --- | --- | --- |
| Plan | you, with the user | everything |
| Review the instruction | `instruction-reviewer` | the instruction, the repository at the base |
| Write the tests | `test-author` | the instruction, the repository at the base |
| Review the tests | `test-reviewer` | the instruction, the author's workspace |
| Implement | `implementer` | the instruction, the repository at the base plus the refactor |

Read [README.md](README.md) for how blindness is enforced and
[config.md](config.md) for every setting. Run every command from the
repository root as `python3 jomaa-agent-pipeline/pipeline.py <command> <task>`.
The agent steps take minutes; run them in the background and wait for them to
finish. On macOS, run them under `caffeinate -i` so the computer doesn't sleep
in the middle of a session.

## 1. Plan the instruction

Work out the change with the user, then write the instruction to a file
outside the repository:

```
# <title>
## Goal         who wants what and why, in product terms
## Requirements numbered R1, R2, ...; each one behavior an outside observer can check
## Contract     every net-new interface a caller could not guess
## Out of scope optional
```

Write it from the product side. Define the net-new contract precisely: routes
and methods, request and response bodies, status codes, messages a caller
relies on, CLI commands and flags, settings, file formats, and new public
functions only when they are the surface callers use. Then describe the
behavior. Leave documentation out of the requirements: `AGENTS.md` already
requires docs to describe the code, prose can't be checked by a test without
fixing its wording, and you check the docs when landing. Never say which files to edit, which helpers to add, which data
structures or algorithms to use, or what the tests will check.

## 2. Review the instruction

```bash
pipeline.py start <task> --instruction <file> [--base <rev>] [--components <folder> ...]
pipeline.py review-instruction <task>
```

`start` exports the base and runs the `prepare` steps of each named component
folder (install dependencies of the folders the change touches). On `revise`,
edit the instruction at the path `start` printed and review again. Settle
product questions with the user, not with a guess. The author refuses to start
until the current instruction text is approved.

## 3. Write and seal the tests

```bash
pipeline.py author <task>
pipeline.py review-tests <task>
pipeline.py author <task> --feedback <review.json>   # after a revise verdict
pipeline.py seal <task>
```

The author refactors the base if the behavior can't be tested from outside,
commits that refactor, and writes the hidden tests and their manifest. Each
review is saved under the task's `reviews/`; pass the latest one back as
feedback on `revise`. `seal` runs every test `sealRuns` times: each
`fail_to_pass` must fail and each `pass_to_pass` must pass before the
implementation exists. It then encrypts the tests, saves the refactor as a
patch, deletes the author's workspace, and prints the key once:
`KEY <hex>`. Keep the key in this conversation only. Never write it to a file
and never pass it to an agent.

## 4. Implement blind

```bash
pipeline.py implement <task>
pipeline.py evaluate <task> --key <hex>
pipeline.py implement <task> --feedback "Requirements not met: R2, R3"
```

`evaluate` applies the implementation to a fresh export, adds the sealed tests
unchanged, runs them, and lists the unmet requirements. The only feedback the
implementer may receive is that line: requirement numbers, never test names,
output or content. After `feedbackRounds` rounds, stop and bring it to the
user.

Never edit, regenerate or relax a sealed test to make it pass. When a test
looks wrong, the instruction or the tests were wrong: `clean` the task and
start again from step 2 with a new implementer, because the old one has seen
feedback.

## 5. Audit the trajectory

```bash
pipeline.py audit <task> --key <hex> [--forbid <file> ...]
```

The audit runs [`anticheat.py`](anticheat.py) over every implementer
trajectory: tool calls that left the workspace or reached the network, tool
results that contain a hidden test line or the canary, and lines from any
`--forbid` file, such as a reference solution, that the implementer read
without writing them itself. A failed audit voids the result no matter what
the tests say. Read the `mention` lines yourself.

## 6. Land

Only when every hidden test passes and the audit passes:

```bash
pipeline.py land <task> --key <hex> --into <worktree>
```

This applies the refactor, the implementation and the hidden tests (canary
removed) to a checkout of the base. Commit the refactor and the feature,
review the diff, ship by the rules in `AGENTS.md`, then `pipeline.py clean
<task>`.
