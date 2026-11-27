-- Lists open tasks in the palette and returns the picked task's key
local cli = require("zinn.cli")

local task_picker = {}

-- Max limit of items accepted by rex.ui.pick
local picker_item_limit = 2000
-- Recognizable enough length
local subtitle_length = 120

local function first_line(text)
  local line = (text or ""):match("^[^\n]*")
  if #line <= subtitle_length then
    return line
  end

  return (line:sub(1, subtitle_length):gsub("[\192-\255][\128-\191]*$", "")) .. "…"
end

-- Returns the key, or `nil` and the reason `rex.ui.pick` gives when nothing was picked.
-- `part` is the calling action's name for the client chain.
function task_picker.choose(part, title)
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

  return rex.ui.pick{ title = title, placeholder = "Filter by key or title", items = items }
end

return task_picker
