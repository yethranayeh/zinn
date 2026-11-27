-- Runs one Zinn action against a Rex API stub and prints what happened as JSON.
-- arg[1]: actions directory
-- arg[2]: Lua file returning the scenario:
--   module  action module name (e.g. "zinn.resume_session")
--   ctx     action context passed to run()
--   args    action args passed to run()
--   zinn    decoded Zinn command output keyed by command (e.g. zinn["activity list"])
--   picks   ordered answers for `rex.ui.pick` and `false` cancels
--   blocks  session blocks and process results keyed by block ID
local root = arg[1]
package.path = root .. "/?.lua;" .. root .. "/?/init.lua;" .. package.path
local scenario = dofile(arg[2])

local calls = {}
local action
local pick_count = 0

local function record(name, value)
  calls[#calls + 1] = { name = name, args = value }
end

local function encode(value)
  local kind = type(value)
  if kind == "string" then
    local escaped = value:gsub('[%c"\\]', function(character)
      return string.format("\\u%04x", character:byte())
    end)
    return '"' .. escaped .. '"'
  end

  if kind == "number" or kind == "boolean" then
    return tostring(value)
  end

  if kind ~= "table" then
    return "null"
  end

  if #value > 0 or next(value) == nil then
    local items = {}
    for _, item in ipairs(value) do
      items[#items + 1] = encode(item)
    end
    return "[" .. table.concat(items, ",") .. "]"
  end

  local names = {}
  for name in pairs(value) do
    names[#names + 1] = name
  end
  table.sort(names)

  local fields = {}
  for _, name in ipairs(names) do
    fields[#fields + 1] = encode(name) .. ":" .. encode(value[name])
  end
  return "{" .. table.concat(fields, ",") .. "}"
end

rex = {
  action = function(definition)
    action = definition
  end,
  exec = function(argv)
    record("exec", argv)
    if argv[1] == "zinn" then
      return { ok = true, stdout = argv[2] .. " " .. argv[3], stderr = "" }
    end

    return { ok = true, stdout = "", stderr = "" }
  end,
  json = {
    decode = function(text)
      return scenario.zinn[text]
    end,
  },
  ui = {
    pick = function(options)
      record("pick", options)
      pick_count = pick_count + 1
      local answer = (scenario.picks or {})[pick_count]
      if answer == nil or answer == false then
        return nil, "cancelled"
      end

      return answer
    end,
  },
  block = {
    call = function(_, method, options)
      record("block." .. method, options)
      return (scenario.processes or {})[options.block_id]
    end,
  },
  session = {
    list_blocks = function()
      return { blocks = scenario.blocks or {} }
    end,
    focus_block = function(options)
      record("focus_block", options)
      return {}
    end,
    new_window = function(options)
      record("new_window", options)
      return { window_id = "window:new", block_ids = { "block:new" } }
    end,
  },
}

require(scenario.module)
local ran, result = pcall(action.run, scenario.ctx or {}, scenario.args or {})
print(encode({ ok = ran, result = ran and result or tostring(result), calls = calls }))
