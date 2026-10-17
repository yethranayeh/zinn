---
name: zinn
description: >-
  Work a Zinn project board alongside coding work. Use before substantial work,
  when resuming work, when recording follow-up tasks, and when finishing a
  reviewable handoff, where the user or repository uses Zinn: the user requests
  it, repository instructions mention it, zinn.local.json exists, or a Zinn task
  key is referenced.
metadata:
  zinn-cli-reviewed-version: "0.41.0"
---

# Work with a Zinn board

Use the user's existing project and workflow. Repository and user instructions determine what work is authorized. Tracking a task does not authorize implementation, commits, publication, or unrelated changes.

## Find the work

1. Before substantial work, resolve the project. Use `zinn info --json` for the configured default project and selected database. If the project remains unidentified, use the user or repository's project setting and `zinn project list --json` to identify it. Ask when the project is ambiguous; do not create a project just to proceed. Result: one identified project in the intended store.
2. Read an explicitly referenced task with `zinn task view <task-key> --json`. Otherwise inspect the project's tasks and find an existing task matching the requested work, then fetch it with `zinn task view <task-key> --json` before changing it. A list or search result does not include the task's comments and relations. Read the full task even when its title and description already match. On resuming, refresh that task instead of creating another. If substantial authorized work has no task, create one describing its scope and completion criteria. Result: a matching task with its description, comments, and relations read.
3. Read the project's columns with `zinn project column list <project-key> --json`. Follow the project's workflow rather than assuming default column names. Check the task's current column before taking it: another agent may already be working on it. Move it to the working column before the first implementation edit. Ask when the workflow or ownership is unclear. Result: the task is visibly in progress before implementation begins.

## Keep context useful

Record meaningful progress, decisions, verification results, and blockers in short task comments. On interrupted work, leave enough context for a later session to resume. Avoid a comment for every command or file read.

These field roles are recommendations the user may adopt:

- Description: the current specification, updated when requirements change.
- Comments: short dated updates containing outcomes, decisions and who made them, measurements, open items, and references. Put bulky evidence in a linked document or PR.
- Columns, relations, and labels: status and structure, rather than repeating that metadata in prose.

When follow-up work appears, search for an existing task before creating one. Record a new task's problem and scope, and link it to the current work. A dependency points from the task that needs something to the task it needs; use a related relation when neither must precede the other. Recording follow-up work does not authorize doing it now. Result: follow-up work has a task and a useful link.

## Finish or hand off

When implementation and appropriate verification are complete, add a concise outcome comment with checks and any remaining limitations, move the task to the project's review column, and report its key with the reviewable result. Follow explicit user or repository completion rules when they differ. If work remains incomplete or blocked, record that state and the next step rather than moving it to review. Result: the board and final report agree about what is ready.

## Use the installed CLI

Discover exact commands and flags with `zinn --help` and `zinn <command> --help`. Follow the installed help if it differs from this skill; the skill and CLI can be updated separately. Use `--json` when consuming results programmatically. Check command exit status: errors go to stderr, and empty stdout from a failed command is not an empty successful result.

If a command or option required by this skill is unavailable, or installed help or command results contradict these instructions, check both the CLI and this skill for drift. Do this once per session, and repeat only if either installation changes. Ordinary input, missing-item, permission, and database errors do not trigger this check.

Compare `zinn --version` with the latest published `@zinn-dev/cli` version in the npm registry, and compare the skill file loaded by this session with its installation source, respecting any pinned revision. The unpinned source is [Zinn's workflow skill](https://github.com/yethranayeh/zinn/blob/main/packages/cli/skills/zinn/SKILL.md). Use read-only metadata and file reads. A newer release or changed skill is evidence of a difference, not proof that it caused the problem. Report relevant differences or checks you could not complete. If the intended operation remains unclear, ask before proceeding. Update either installation only when authorized; after updating the skill, reload it or use a fresh session.

`ZINN_AGENT`, `ZINN_MODEL`, and `ZINN_EFFORT` can declare the agent, model, and effort of the execution making a change when automatic detection or host integration does not provide them. Use only known values; leave unknown values unset.

Checking and moving a task is not an atomic claim. Coordinate parallel work with the user or host; task coordination does not isolate a shared working tree.

For example, substitute the actual project, task, and observed column names:

```sh
zinn --help
zinn info --json
zinn project list --json
zinn task list APP --json
zinn task view APP-1 --json
zinn project column list APP --json
zinn task move APP-1 'In Progress' --json
zinn task comment create APP-1 --text 'Implementation verified; ready for review.' --json
zinn task move APP-1 Review --json
```
