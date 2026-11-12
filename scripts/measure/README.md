# Measurement harness

Measures a published `@zinn-dev/cli` release: time, peak memory and output per command, database size on disk, and processor energy. Every run writes a dated record folder. Records are kept, never overwritten.

Development only. Requires macOS, Node and [hyperfine](https://github.com/sharkdp/hyperfine) 2.x on `PATH`. Energy mode also needs `sudo` for `powermetrics`.

## Check existing records first

Results live in `.measure/results/`, one folder per run:

```
.measure/results/<yyyymmdd-hhmmss>-<mode>-<version>/
```

If a record for the same mode, version, sizes and commands exists and its load was low, use it instead of measuring again. `meta.json` in each folder says how the run was made.

## Modes

```sh
bun run measure time <version> [--sizes 100,1000,10000] [--runs 30] [--warmup 3] [--commands list,view,...]
bun run measure disk <version>
bun run measure energy <version> [--rounds 5] [--check] [--sizes 100,10000] [--commands list,view,...]
bun run measure energy-analyze <power.plist> <blocks.tsv>
```

Commands: `list`, `list-json`, `view`, `create`, `move`, `search`, `backup`. Each runs against task `BNCH-50` or project `BNCH` in the fixture (`zinn/commands.ts`).

- **time** runs every selected command at every size through hyperfine. Each run starts from a fresh copy of the fixture. It also times `node -e 0` and `zinn --version`. Records: `t<size>.json` (hyperfine exports with peak memory), `startup.json`, `outputs.json` (stdout bytes, exit code, database size and files left per command).
- **disk** builds fixtures with and without comments and writes the bytes an empty database, a task and a comment take (`disk.json`).
- **energy** alternates idle and work blocks in a seeded shuffled order while `powermetrics` samples processor power every 500 ms. Energy per command is work minus the neighbouring idle, as a median over rounds. Without `--commands` or `--sizes` it measures the fixed set: `node -e 0`, `list`, `list-json`, `view` and `create` at 100 tasks, and `list` at 10,000. `--check` is a short smoke run (one round of 5-second blocks). Records: `power.plist` (raw samples, about 65 MB for a full run), `blocks.tsv`, `analysis.json`.
- **energy-analyze** reruns the analysis on a saved plist and block log, for checking a change to the method against an old run. Pass the session's `samples.tsv` as a third path to apply the contamination check too.

A full energy run takes about 25 minutes and a full time run about 6.

## Installs and fixtures

Each version is installed once from npm into `~/Library/Caches/zinn-measure/<version>/` (`ZINN_MEASURE_HOME` moves it). Fixtures are built there once with that version's own core and reused. Each task has a 40-character title, a 200-character description and, in `-c1` fixtures, one 200-character comment (`zinn/setup.ts`). Measured commands run with `ZINN_DIR` set to a scratch folder in the cache, so they never touch `~/.zinn`.

## The record

Every folder has `meta.json`: mode, arguments, git commit and whether the tree was dirty, CLI, core, Node and hyperfine versions, macOS build and machine, load averages at start and end, and start and end times. Energy records add the machine preflight (power source and free disk), the `powermetrics` build check and `quietGate`: its limits, the waits before blocks and the number of extra rounds.

Compare a record's start load with other records from the same machine. Timings taken under much higher load are provisional.

## Energy method rules

- `powermetrics` ships with macOS and changes with it. Before each run a two-sample preflight checks that the fields the analysis reads exist and give plausible values. A build with no sample in `energy/known-good/` is reported as untested. After a verified run on a new build, add its sample there.
- A round is dropped when an idle block exceeds 1,000 mW or a work block exceeds 1.5 times its workload's median. A workload with fewer than four clean rounds is marked for a rerun. A spread above 50% means the figure is not stated (`energy/analysis.ts`).
- Before each block the run waits while the one-minute load is above 3.5, for at most 60 seconds, and records each wait. A block that still starts busy is judged by the next rule.
- Inside a quiet session, a block is contaminated when a session sample taken during it shows a load above 3.5, or a known background service (Spotlight, Time Machine, photo and Siri analysis, software update) at 20% CPU or more. A contaminated block drops its round like a power spike (`energy/gate.ts`). Run alone, the job has no session samples and skips this check.
- When the planned rounds leave a workload with fewer than four clean rounds, the run adds up to three extra rounds for the workloads still short. A run planned with fewer than four rounds, such as `--check`, gets none. The session can run past its estimate.
- The thresholds sit above everything two clean quiet sessions recorded (load at most 3.1) and below a normal desktop with apps open (about 4.4).
- The figure is whole-machine processor energy above idle, not energy of one process.

## Quiet sessions

Long runs belong in one unattended quiet session, not a busy desktop:

```sh
bun run measure:quiet --spotlight-off --wifi-off --jobs jobs.json
bun run measure:quiet --dry-run --wifi-off --jobs jobs.json
bun run measure:quiet --wifi-off -- bun run measure time 0.44.0
bun run measure:quiet restore
```

A jobs file is a JSON array of `{ "name", "command", "estimateMinutes" }`. Example:

```json
[
	{ "name": "energy", "command": "bun run measure energy 0.44.0", "estimateMinutes": 26 },
	{ "name": "timings", "command": "bun run measure time 0.44.0", "estimateMinutes": 9 }
]
```

The session asks for the password once, keeps the Mac awake, changes only the settings its flags name (`--spotlight-off`, `--time-machine-off`, `--wifi-off`) and restores them on exit, including a closed terminal or a killed wrapper. Before changing anything it writes a restore state file, so `restore` can undo a session lost to a crash or power cut. `--dry-run` prints the plan and changes nothing. With `--wifi-off`, every job must work offline: an install that is not cached yet fails. `--spotlight-off` leaves a volume whose index `mdutil` reports as read-only unchanged, such as the sealed system volume.

Each session writes `.measure/sessions/<id>/`: `session.log`, `status.txt` (one-line progress), `guard.log` (restores) and `samples.tsv` (load and the busiest processes every 5 seconds). Read `samples.tsv` beside a record to see what else ran during it. Jobs get its path in `ZINN_MEASURE_SESSION_SAMPLES`, which the energy job reads for its contamination check.

## Layout

- `quiet-session/`: the session wrapper and its root restore guard. Knows nothing about Zinn.
- `energy/`: the energy method (plist parsing, schedule, analysis, preflight). Knows nothing about Zinn.
- `record.ts`: record folders and `meta.json` writing.
- `zinn/`: everything Zinn-specific. Installs, fixtures, command sets, modes and the entry point.

Tests: `bun run test scripts/measure`.
