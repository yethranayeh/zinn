import type { Plugin } from "@opencode/plugin/tui";

export type Ctx = Plugin.Context;
export type TaskSummary = {
  key: string;
  title: string;
  status: string;
  column: string;
  priority: string | null;
  labels: string[];
};
export type Relation = {
  type: string;
  direction: string;
  task: {
    key: string;
    title: string;
    status: string;
  };
};
export type TaskDetail = {
  key: string;
  title: string;
  status: string;
  column: string;
  priority: string | null;
  labels: string[];
  relations: Relation[];
  comments: number;
  description: string;
};
export type Loaded<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      error: string;
      code?: string;
    };
export type Mention = {
  key: string;
  count: number;
};
export type Scan = {
  known: Mention[];
  unknown: Mention[];
  tokens: number;
  textParts: number;
  streamingParts: number;
  zinnCommands: number;
  ms: number;
};
export type DetailState =
  | {
      kind: "loading";
    }
  | {
      kind: "ready";
      detail: TaskDetail;
    }
  | {
      kind: "error";
      error: string;
    };
