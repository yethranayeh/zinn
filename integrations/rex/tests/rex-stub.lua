-- Loads the zinn actions' cli module with a stand-in for Rex's Lua API and runs one command
-- ZINN_TEST_RUNS times. rex.exec starts real processes. rex.json.decode returns the raw text.
-- Prints one line per run, then the programs rex.exec was asked to start.
local root = arg[1]
package.path = root .. "/?.lua;" .. root .. "/?/init.lua;" .. package.path

local started = {}

local function quote(text)
  return "'" .. text:gsub("'", "'\\''") .. "'"
end

-- Lua 5.1 returns the wait status, later versions return true on success
local function exit_code(status)
  if type(status) == "number" then
    return math.floor(status / 256)
  end

  return status and 0 or 1
end

local function read_and_remove(path)
  local handle = io.open(path, "r")
  local text = handle:read("*a")
  handle:close()
  os.remove(path)
  return text
end

-- Looks a program up the way Rex does: a name without a slash is searched for in the command's PATH
local function find_program(name, path)
  if name:find("/") then
    return name
  end

  for directory in (path .. ":"):gmatch("([^:]*):") do
    local candidate = directory .. "/" .. name
    if directory ~= "" and exit_code(os.execute("test -x " .. quote(candidate))) == 0 then
      return candidate
    end
  end

  return nil
end

rex = {
  json = {
    decode = function(text)
      return { text = text }
    end,
  },
  exec = function(argv, options)
    options = options or {}
    local env = options.env or {}
    started[#started + 1] = argv[1]

    local program = find_program(argv[1], env.PATH or os.getenv("PATH") or "")
    if program == nil then
      return nil, "exec: " .. argv[1] .. ": executable file not found in $PATH"
    end

    local words = { "env" }
    for name, value in pairs(env) do
      words[#words + 1] = name .. "=" .. quote(value)
    end

    words[#words + 1] = quote(program)
    for index = 2, #argv do
      words[#words + 1] = quote(argv[index])
    end

    local stdout_path, stderr_path = os.tmpname(), os.tmpname()
    local command = table.concat(words, " ") .. " </dev/null >" .. quote(stdout_path) .. " 2>" .. quote(stderr_path)
    local code = exit_code(os.execute(command))

    return {
      code = code,
      ok = code == 0,
      stdout = read_and_remove(stdout_path),
      stderr = read_and_remove(stderr_path),
    }
  end,
}

local cli = require("zinn.cli")

for _ = 1, tonumber(os.getenv("ZINN_TEST_RUNS") or "1") do
  local ran, value = pcall(cli.run, "test", { "task", "list" })
  if ran then
    print("result " .. value.text:gsub("\n", " "))
  else
    print("error " .. value)
  end
end

print("started " .. table.concat(started, " "))
