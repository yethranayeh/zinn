-- Zinn: New task. Asks for a title and a project, then creates the task
local cli = require("zinn.cli")
local notify = require("zinn.notify")

local part = "new-task"

local function choose_project()
  local items = {}
  for _, project in ipairs(cli.run(part, { "project", "list" })) do
    items[#items + 1] = {
      id = project.key,
      title = project.name,
      subtitle = project.key,
      detail = tostring(project.taskCounts.active) .. " active",
      icon = "folder",
    }
  end

  return rex.ui.pick{ title = "Project", placeholder = "Filter projects", items = items }
end

rex.action{
  name = "zinn_new_task",
  title = "Zinn: New task",
  category = "Zinn",
  description = "Create a Zinn task from a title and a project.",
  keywords = "zinn task new create capture",
  args = { title = "string?", project = "string?" },
  run = function(_, args)
    local reason
    local title = args.title

    if title == nil then
      title, reason = rex.ui.input{ title = "New task", placeholder = "What needs doing?", confirm = "Choose project" }
      if title == nil then
        return { created = false, reason = reason }
      end
    end

    local project = args.project

    if project == nil then
      project, reason = choose_project()
      if project == nil then
        return { created = false, reason = reason }
      end
    end

    -- Joined with = so that a title starting with a dash stays the flag's value
    local task = cli.run(part, { "task", "create", project, "--title=" .. title })
    notify.show("Created " .. task.key, task.title)
    return { created = true, task = task.key }
  end,
}
