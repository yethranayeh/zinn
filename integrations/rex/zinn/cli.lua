-- Runs the zinn CLI where the Rex server runs and returns its decoded JSON output
local cli = {}

-- Version is recorded in each command's client chain
local version = "0.1.0"
local command_timeout_seconds = 20

local function client_chain(part)
  local token = "zinn-rex:" .. part .. "/" .. version
  local inherited = (os.getenv("ZINN_CLIENT") or ""):match("^%s*(.-)%s*$")
  if inherited == "" then
    return token
  end
  return inherited .. " " .. token
end

-- Runs `zinn <words> --json` and returns the decoded result.
-- part is the calling action's name, such as "new-task", for the client chain.
function cli.run(part, words)
  local argv = { "zinn" }
  for _, word in ipairs(words) do
    argv[#argv + 1] = word
  end

  argv[#argv + 1] = "--json"
  local result, run_error = rex.exec(argv, {
    env = { ZINN_CLIENT = client_chain(part) },
    timeout = command_timeout_seconds,
  })

  if result == nil then
    error("zinn did not run. Check that it is on the PATH of the Rex server: " .. tostring(run_error), 0)
  end

  -- Zinn writes its JSON errors to stderr
  local decoded, value = pcall(rex.json.decode, result.ok and result.stdout or result.stderr)
  if not result.ok then
    local message = (decoded and value and value.error and value.error.message) or result.stderr
    error("zinn " .. table.concat(words, " ") .. " failed: " .. message, 0)
  end

  if not decoded then
    error("zinn " .. table.concat(words, " ") .. " returned output that is not JSON.", 0)
  end

  return value
end

return cli
