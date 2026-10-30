export type HookPayload = {
  hook_event_name?: string;
  session_id?: string;
  agent_id?: string;
  agent_type?: string;
  parent_agent_id?: string;
  turn_id?: string;
  model?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  last_assistant_message?: unknown;
  transcript_path?: string;
};
