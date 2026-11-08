import { Ipc } from "@opencode/plugin/gui";
import { Schema } from "effect";

export type BoardSummary = {
  total: number;
  columns: Array<{ name: string; count: number }>;
  readAt: number;
};

export const Board = Ipc.define({
  id: "zinn.board",
  methods: {
    read: {
      input: Schema.Array(Schema.String),
      output: Schema.String,
    },
  },
});
