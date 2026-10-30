export const INSPECTOR_VERSION = "0.1.0";
export const RECENT_POLL_MS = 5000;
export const BACKEND_PROFILE = "(version 1)(allow default)(deny file-write*)(deny network*)";
export function backendArguments(executable: string, ...args: string[]) {
  return ["-p", BACKEND_PROFILE, executable, ...args];
}
