-- Runs the zinn CLI where the Rex server runs and returns its decoded JSON output
local cli = {}

-- The actions' version, recorded in each command's client chain and exposed as require("zinn").version
local version = "0.1.0"
cli.version = version

local command_timeout_seconds = 20
local shell_timeout_seconds = 10
-- Printed around the shell's environment so that output from its startup files is skipped
local environment_marker = "__zinn_rex_environment__"

-- The login shell's PATH, looked up once when zinn is not on the server's PATH
local shell_path

local function client_chain(part)
  local token = "zinn-rex:" .. part .. "/" .. version
  local inherited = (os.getenv("ZINN_CLIENT") or ""):match("^%s*(.-)%s*$")
  if inherited == "" then
    return token
  end
  return inherited .. " " .. token
end

-- Desktop-spawned Rex servers inherit a minimal PATH missing package manager
--  directories (e.g., zinn). Running through an interactive login shell sources
--  user profile scripts to resolve this.
local function login_shell_path()
  local shell = os.getenv("SHELL")
  if shell == nil or shell == "" then
    return nil
  end

  local script = "echo " .. environment_marker .. "; env; echo " .. environment_marker
  local result = rex.exec({ shell, "-i", "-l", "-c", script }, { stdin = "", timeout = shell_timeout_seconds })
  if result == nil or not result.ok then
    return nil
  end

  local environment = result.stdout:match(environment_marker .. "\n(.-)" .. environment_marker)
  if environment == nil then
    return nil
  end

  return ("\n" .. environment):match("\nPATH=([^\n]*)")
end

-- Runs zinn from the server's PATH, or else from the login shell's PATH
local function run_zinn(argv, env)
  local options = { env = env, timeout = command_timeout_seconds }
  if shell_path ~= nil then
    env.PATH = shell_path
    return rex.exec(argv, options)
  end

  local result, run_error = rex.exec(argv, options)
  if result ~= nil then
    return result
  end

  shell_path = login_shell_path()
  if shell_path == nil then
    return nil, run_error
  end

  env.PATH = shell_path
  return rex.exec(argv, options)
end

-- Runs `zinn <words> --json` and returns the decoded result.
-- part is the calling action's name, such as "new-task", for the client chain.
function cli.run(part, words)
  local argv = { "zinn" }
  for _, word in ipairs(words) do
    argv[#argv + 1] = word
  end

  argv[#argv + 1] = "--json"
  local result, run_error = run_zinn(argv, { ZINN_CLIENT = client_chain(part) })

  if result == nil then
    error("zinn did not run. Check that it is on the PATH of the Rex server or of your login shell: " .. tostring(run_error), 0)
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
