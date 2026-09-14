# @zinn-dev/cli

The `zinn` command-line interface. Requires [Bun](https://bun.sh).

## Install

```sh
bun add --global @zinn-dev/cli
```

Zinn stores projects and tasks in the shared local database at `~/.zinn/data/zinn.sqlite`.
Set `ZINN_DIR` to use another Zinn directory and keep using the same value for commands that should share that database.

## Start a project

Create a project with a name and a short key that begins with a letter and then uses only letters and numbers:

```sh
zinn project create "Website refresh" SITE
```

Project keys are stored in uppercase. Each project starts with _Backlog_, _TODO_, _In Progress_, _Review_, and _Done_ columns. List projects or inspect a project's columns with:

```sh
zinn project list
zinn project column list SITE
```

Rename a project:

```sh
zinn project edit SITE --name "Website redesign"
```

The `--name` flag is required. Names must contain printable text on a single line.
Supplying the current name leaves the modification timestamp unchanged.
Use `--name="--example"` when a value begins with a dash.

Add another column at the end of the board:

```sh
zinn project column create SITE "Waiting"
```

`zinn project delete SITE` permanently deletes the project and all of its columns and tasks. The command does not ask for confirmation.

## Create and read tasks

Create a task with a title and an optional description. New tasks enter the project's first column:

```sh
zinn task create SITE "Rewrite the home page"
zinn task create SITE "Check the mobile layout" "Test the navigation at narrow widths"
```

Tasks are created with keys such as `SITE-1`. List active tasks, optionally limited to one project, or view one task:

```sh
zinn task list
zinn task list SITE
zinn task view SITE-1
```

When a project key is supplied, the list follows the project's column order and the task order within each column.

## Edit tasks

Edit a task's title, description, or both:

```sh
zinn task edit SITE-1 --title "Rewrite the landing page"
zinn task edit SITE-1 --description "Include the new product screenshots"
zinn task edit SITE-1 --title "Rewrite the landing page" --description ""
```

Omitted fields stay unchanged. An empty description is stored as an empty string.

At least one flag is required and task titles cannot be blank. Archived tasks can be edited without unarchiving them. Supplying unchanged values does not change the modification timestamp.
Use `--title="--example"` when a value begins with a dash.

## Move and order tasks

Move a task to another column in its project:

```sh
zinn task move SITE-1 "In Progress"
```

A moved task appears at the bottom of its destination column. Moving it to its current column does nothing. Archived tasks must be unarchived before they can be moved.

Change a task's position within its current column:

```sh
zinn task order SITE-2 top
zinn task order SITE-2 up
zinn task order SITE-2 down
zinn task order SITE-2 bottom
zinn task move SITE-2 "In Progress"
zinn task order SITE-2 before SITE-1
zinn task order SITE-2 after SITE-1
```

The task being reordered and the target of `before` or `after` must be active tasks in the same column.

## Archive and delete tasks

Active tasks are shown by default. Archive a task to hide it from active lists, then list archived tasks or all tasks:

```sh
zinn task archive SITE-1
zinn task list SITE --archived
zinn task list SITE --all
```

`--archived` and `--all` cannot be used together. In an `--all` listing, Zinn adds an Active or Archived status column.

Unarchiving puts a task at the bottom of its previous column:

```sh
zinn task unarchive SITE-1
```

Delete a task permanently with `zinn task delete SITE-1`. Unlike project deletion, task deletion asks for confirmation.

## Help

Use root or namespace help to discover commands, then open a command's help for its arguments and behavior:

```sh
zinn --help
zinn project --help
zinn project column --help
zinn task --help
zinn task move --help
```

The short `-h` form works in the same positions.

Running `zinn` without a command launches the work-in-progress TUI when attached to an interactive terminal. The commands documented above provide the complete current workflow.
