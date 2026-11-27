-- Zinn: Resume session. Opens a new tab for the session that chnaged a specific task
local cli = require("zinn.cli")
local notify = require("zinn.notify")
local task_picker = require("zinn.task_picker")

local part = "resume-session"
local terminal = "com.superlogical.terminal"
local shell_flavor = "com.superlogical.terminal.shell"
-- Pressing Return in the new tab's shell runs the typed command
local enter = "\r"

-- Hosts whose session IDs resume a conversation. A record belongs to a host when its actor
--  name is the host's name or starts with the host name, like for example `claude-code_2-1-330_agent`
local hosts = {
  { name = "claude-code", title = "Claude Code", command = "claude --resume " },
  { name = "opencode", title = "OpenCode", command = "opencode --session " },
  { name = "codex", title = "Codex", command = "codex resume " },
}

local function host_of(actor_name)
  for _, host in ipairs(hosts) do
    local prefix = actor_name:sub(1, #host.name)
    local rest = actor_name:sub(#host.name + 1)
    local names_host = prefix == host.name and (rest == "" or rest:find("^[^%w]") ~= nil)
    if names_host then
      return host
    end
  end

  return nil
end

-- The distinct agent sessions in a task's activity, with newest shown first.
-- OpenCode records only a thread when nothing declares a session,
--  so that's the thread the session resumes.
local function sessions_of(events)
  local sessions = {}
  local seen = {}

  for _, event in ipairs(events) do
    local host = event.actor_kind == "agent" and event.actor_name and host_of(event.actor_name)
    local id = event.actor_session_id or event.actor_thread_id
    -- Session IDs are typed into a shell, so only plain IDs are used
    local is_plain_id = id ~= nil and id:find("^[%w_%-]+$") ~= nil

    if host and is_plain_id then
      local key = host.name .. " " .. id
      local session = seen[key]
      if session == nil then
        session = { host = host, id = id, created_at = event.created_at, model = event.actor_model }
        seen[key] = session
        sessions[#sessions + 1] = session
      end

      session.directory = session.directory or event.actor_directory
    end
  end

  return sessions
end

local function choose_session(key, sessions)
  local items = {}
  for index, session in ipairs(sessions) do
    items[#items + 1] = {
      id = tostring(index),
      title = session.model and (session.host.title .. "  " .. session.model) or session.host.title,
      subtitle = session.directory or session.id,
      detail = os.date("%Y-%m-%d %H:%M", math.floor(session.created_at / 1000)),
      icon = "terminal",
    }
  end

  local picked, reason = rex.ui.pick{ title = "Sessions that changed " .. key, items = items }
  if picked == nil then
    return nil, reason
  end

  return sessions[tonumber(picked)]
end

local function file_exists(path)
  local handle = io.open(path, "r")
  if handle == nil then
    return false
  end

  handle:close()
  return true
end

-- Claude Code resumes a session only from the folder it started in. It keeps the transcript
-- at projects/<folder>/<id>.jsonl, with each character of the folder other than a letter or
-- digit written as -. The recorded folder can be one the agent moved into, so its parents are
-- tried too.
local function claude_start_directory(directory, id)
  local home = os.getenv("HOME") or os.getenv("USERPROFILE")
  local config = os.getenv("CLAUDE_CONFIG_DIR") or (home and home .. "/.claude")
  if config == nil then
    return directory
  end

  local candidate = directory
  while candidate ~= nil and candidate ~= "" do
    local project = (candidate:gsub("[^%w]", "-"))
    if file_exists(config .. "/projects/" .. project .. "/" .. id .. ".jsonl") then
      return candidate
    end

    candidate = candidate:match("^(.*)[/\\][^/\\]*$")
  end

  return directory
end

local function block_label(session)
  return session.host.title .. " " .. session.id
end

-- Session pane opened by this action while a non-shell process runs inside it
local function running_pane(session)
  local listing = rex.session.list_blocks{}
  for _, block in ipairs(listing and listing.blocks or {}) do
    if block.label == block_label(session) and block.placement == "placed" then
      local process = rex.block.call(terminal, "process", { block_id = block.block_id })
      local foreground = process and process.foreground
      local runs_program = foreground ~= nil and process.child ~= nil and foreground.pid ~= process.child.pid
      if runs_program and process.last_exit == nil then
        return block.block_id
      end
    end
  end

  return nil
end

local function open_session(key, session, directory)
  local _, open_error = rex.session.new_window{
    window_label = key,
    layout = {
      block = {
        flavor = shell_flavor,
        label = block_label(session),
        options = { cwd = directory, initial_input = session.host.command .. session.id .. enter },
      },
    },
  }
  if open_error then
    error(open_error, 0)
  end
end

rex.action{
  name = "zinn_resume_session",
  title = "Zinn: Resume session",
  category = "Zinn",
  description = "Open the agent conversation that changed a Zinn task.",
  keywords = "zinn task resume session conversation agent claude opencode codex",
  args = { task = "string?" },
  run = function(_, args)
    local key = args.task

    if key == nil then
      local reason
      key, reason = task_picker.choose(part, "Resume session")
      if key == nil then
        return { resumed = false, reason = reason }
      end
    end

    local sessions = sessions_of(cli.run(part, { "activity", "list", "--task", key }))
    if #sessions == 0 then
      notify.show("No session to resume", "No Claude Code, OpenCode or Codex session changed " .. key .. ".")
      return { resumed = false, reason = "no_session" }
    end

    local session = sessions[1]
    if #sessions > 1 then
      local reason
      session, reason = choose_session(key, sessions)
      if session == nil then
        return { resumed = false, reason = reason }
      end
    end

    local block_id = running_pane(session)
    if block_id ~= nil then
      rex.session.focus_block{ block_id = block_id }
      return { resumed = true, task = key, session = session.id, focused = true }
    end

    local directory = session.directory
    if directory ~= nil and session.host.name == "claude-code" then
      directory = claude_start_directory(directory, session.id)
    end

    open_session(key, session, directory)
    return { resumed = true, task = key, session = session.id, focused = false }
  end,
}
