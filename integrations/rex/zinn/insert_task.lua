local cli = require("zinn.cli")

local part = "insert-task"
local terminal = "com.superlogical.terminal"
-- Max limit of items accepted by rex.ui.pick
local picker_item_limit = 2000
-- Recognizable enough length
local subtitle_length = 120
local paste_start = "\27[200~"
local paste_end = "\27[201~"

local function first_line(text)
  local line = (text or ""):match("^[^\n]*")
  if #line <= subtitle_length then
    return line
  end

  return (line:sub(1, subtitle_length):gsub("[\192-\255][\128-\191]*$", "")) .. "…"
end

local function choose_task()
  local tasks = cli.run(part, {
    "task", "list", "--all-projects", "--state", "open",
    "--sort", "activity", "--limit", tostring(picker_item_limit),
  })

  local items = {}
  for _, task in ipairs(tasks) do
    items[#items + 1] = {
      id = task.key,
      title = task.key .. "  " .. task.title,
      subtitle = first_line(task.description),
      detail = task.column,
      icon = "tag",
    }
  end

  return rex.ui.pick{ title = "Insert task", placeholder = "Filter by key or title", items = items }
end

local function block_call(method, block_id)
  local result, call_error = rex.block.call(terminal, method, { block_id = block_id })
  if call_error then
    error(call_error, 0)
  end

  return result
end

local function running_program(block_id)
  local process = block_call("process", block_id)
  local program = process.foreground or process.child
  local has_program = program ~= nil and program.pid ~= nil and process.last_exit == nil
  if not has_program then
    error("The pane has no running program to insert into.", 0)
  end

  return program
end

local function accepts_paste(block_id)
  for _, mode in ipairs(block_call("modes", block_id).modes) do
    if mode.name == "bracketed_paste" then
      return mode.set
    end
  end

  return false
end

local function paste_text(task)
  local text = task.key .. ": " .. task.title
  if (task.description or "") ~= "" then
    text = text .. "\n\n" .. task.description
  end

  text = text:gsub("\r\n?", "\n")
  -- Tab and newline are the only control characters a paste may carry
  local has_c0_control = text:find("[%z\1-\8\11\12\14-\31\127]") ~= nil
  local has_c1_control = text:find("\194[\128-\159]") ~= nil
  if has_c0_control or has_c1_control then
    error("The task text contains terminal control characters. Nothing was inserted.", 0)
  end

  return paste_start .. text .. paste_end
end

local function insert_task(block_id, origin, key)
  local payload = paste_text(cli.run(part, { "task", "view", key }))
  local current = running_program(block_id)
  local program_changed = current.pid ~= origin.pid or current.path ~= origin.path
  if program_changed then
    error("The program in the pane changed. Nothing was inserted.", 0)
  end

  if not accepts_paste(block_id) then
    error("The program in the pane does not accept pasted text. Nothing was inserted.", 0)
  end

  rex.session.focus_block{ block_id = block_id }
  local _, write_error = rex.block.call(terminal, "write", { block_id = block_id, data = payload })
  if write_error then
    error(write_error, 0)
  end
end

rex.action{
  name = "zinn_insert_task",
  title = "Zinn: Insert task",
  category = "Zinn",
  description = "Paste an open Zinn task into this pane without sending it.",
  keywords = "zinn task insert paste draft context",
  args = { task = "string?" },
  run = function(ctx, args)
    if ctx.block_id == nil then
      error("Run this from the terminal pane that should receive the task.", 0)
    end

    local origin = running_program(ctx.block_id)
    local key = args.task

    if key == nil then
      local reason
      key, reason = choose_task()
      if key == nil then
        return { inserted = false, reason = reason }
      end
    end

    insert_task(ctx.block_id, origin, key)
    return { inserted = true, task = key }
  end,
}
