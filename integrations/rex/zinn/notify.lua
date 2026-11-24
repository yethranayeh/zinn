-- Shows a system notification when the Rex server runs on a macOS or Windows desktop.
-- Elsewhere, or when that fails, the palette shows the message instead.
local notify = {}

local osascript = "/usr/bin/osascript"
local notification_timeout_seconds = 10
local is_windows = package.config:sub(1, 1) == "\\"

-- Windows PowerShell's app ID, which Windows accepts as the sender of a notification.
local powershell_app_id = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe"
local windows_toast = table.concat({
  "$ErrorActionPreference = 'Stop'",
  "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
  "$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
  "$lines = $xml.GetElementsByTagName('text')",
  "$lines.Item(0).AppendChild($xml.CreateTextNode($env:ZINN_REX_HEADING)) | Out-Null",
  "$lines.Item(1).AppendChild($xml.CreateTextNode($env:ZINN_REX_TEXT)) | Out-Null",
  "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('" .. powershell_app_id .. "').Show($toast)",
}, "; ")

local function has_osascript()
  local handle = io.open(osascript, "r")
  if handle == nil then
    return false
  end

  handle:close()

  return true
end

local function macos_notification(heading, text)
  -- Pass the text as arguments, not inside the script, so a quote in a title can't break it.
  return rex.exec({
    osascript,
    "-e", "on run argv",
    "-e", "display notification (item 2 of argv) with title (item 1 of argv)",
    "-e", "end run",
    heading, text,
  }, { timeout = notification_timeout_seconds })
end

local function windows_notification(heading, text)
  -- The text travels in environment variables for the same reason.
  return rex.exec({ "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", windows_toast }, {
    env = { ZINN_REX_HEADING = heading, ZINN_REX_TEXT = text },
    timeout = notification_timeout_seconds,
  })
end

function notify.show(heading, text)
  local result
  if is_windows then
    result = windows_notification(heading, text)
  elseif has_osascript() then
    result = macos_notification(heading, text)
  end

  if result and result.ok then
    return
  end

  rex.ui.pick{ title = heading, items = { { id = "ok", title = text } } }
end

return notify
