# Schema snapshots

Each `v<version>.json` holds the definitions Zinn creates at that schema version.
Tests compare fresh and upgraded databases with them, so changing what a released
baseline or migration does fails a test.

Add a snapshot with each new migration. After registering the migration, run this
from the repository root:

```sh
bun packages/core/testing/capture-schema.ts
```

Keep existing snapshots unchanged. The script refuses to overwrite one.
