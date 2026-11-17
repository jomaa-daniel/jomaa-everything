---
name: jomaa-agent-pipeline
description: Run a change through the blind pipeline as an unattended job — from a product instruction, or by rebuilding a change that already landed — with reviewed and sealed hidden tests, several blind implementers, a trajectory audit, and a pull request merged once CI is green. Use only when the user explicitly requests the blind pipeline.
---

# The blind pipeline

This pipeline is dormant by default. Run it only when the user explicitly
requests it.

The job is the orchestrator, not you. `pipeline.py run` dispatches every agent,
judges every response, and lands the result; read [README.md](README.md) for
its stages and [config.md](config.md) for its settings. Your part is to
prepare its input, start it, and report on it. Never run agents, edit task
state, or push its branch yourself while a job runs.

## From an instruction

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
behavior. Leave documentation out of the requirements. Never say which files
to edit, which helpers to add, which data structures or algorithms to use, or
what the tests will check. Then start the job:

```bash
nohup python3 jomaa-agent-pipeline/pipeline.py run <task> --instruction <file> \
  [--components <folder> ...] > <log> 2>&1 &
```

If it fails at stage `instruction`, settle the report's findings with the
user, `clean` the task, and start again.

## From a landed change

When the user wants a landed change rebuilt, start the job with the commit,
or the range, that introduced it:

```bash
nohup python3 jomaa-agent-pipeline/pipeline.py run <task> --change <rev | from..to> > <log> 2>&1 &
```

## While it runs and after

Check progress with `pipeline.py status <task>` and the log; don't poll in a
tight loop, since a job takes hours. When it ends, read
`<stateDir>/reports/<task>.json` and tell the user the outcome, the stage it
stopped at, the cost, the attempts and the pull request. A failed task keeps
its logs, reviews and audits under `<stateDir>/tasks/<task>`; once the user
has what they need, run `pipeline.py clean <task>`.
