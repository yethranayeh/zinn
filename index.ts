import { createCliRenderer, Box, Text } from "@opentui/core";

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
});

renderer.root.add(
  Box(
    { borderStyle: "rounded", padding: 1, flexDirection: "column", gap: 1 },
    Text({ content: "Kanbun", fg: "#00a6ffff" }),
    Text({ content: "A kanban workflow for your terminal. Built on OpenTUI.", fg: "#00c8ffff" }),
    Text({ content: "Press Ctrl+C to exit" }),
  ),
);
