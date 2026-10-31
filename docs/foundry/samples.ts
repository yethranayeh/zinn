// Sample rows that Foundry's table pages share.
export const aliases = [
  ["view", "show"],
  ["list", "ls"],
  ["delete", "rm"],
  ["create", "new"],
];

export const options = [
  [
    "store",
    "CLI selection",
    "Optional absolute Zinn data directory for inspection and reply verification.",
  ],
  ["cli", '["zinn"]', "Executable and fixed arguments used for local reads."],
  [
    "dataDirectory",
    "~/.local/share/zinn-codex",
    "Absolute directory for reference files, outside the Zinn data directory.",
  ],
  ["observe", "true", "Record task references for the current-chat list."],
  [
    "identity",
    "true",
    "Supply the callback's agent profile and model to supported direct commands.",
  ],
  [
    "captureEffort",
    "false",
    "Read exact execution metadata from the callback's transcript file to supply effort.",
  ],
];
