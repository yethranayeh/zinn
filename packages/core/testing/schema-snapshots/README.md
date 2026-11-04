# Schema snapshots

Add a fixed `v<version>.json` with each migration. Tests compare stored SQL exactly
on Bun and Node and check that each snapshot reconstructs a recognized backup.
Keep existing snapshots unchanged.

## Capture a new snapshot

Prepare an isolated source copy at the full base commit, with dependencies
installed, then apply the pending core changes there. From the repository root:

```sh
bun packages/core/testing/capture-schema.ts \
  "$source_tree" "$base_commit" "$snapshot_path" \
  packages/core/src/migrations/registry.ts \
  packages/core/src/migrations/new-migration.ts
```

Set `snapshot_path` to the new `v<version>.json` in this directory. List every
changed, added or deleted core input after it, including
`packages/core/package.json` when changed.
For a source copy that exactly matches the commit, omit that list.

The snapshot records the source commit and hashes of pending inputs. The tool
refuses to overwrite an existing snapshot.
