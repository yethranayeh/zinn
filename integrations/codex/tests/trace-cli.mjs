import childProcess from "node:child_process";
import { writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const began = performance.now();
const calls = [];
const spawn = childProcess.spawn;

// Trace the hook's actual children without adding another CLI wrapper process.
childProcess.spawn = function (file, args, options) {
	const call = { file, args, startedMs: performance.now() - began, kills: [] };
	calls.push(call);
	const child = spawn(file, args, options);
	const kill = child.kill;
	child.kill = function (signal) {
		call.kills.push({ signal, atMs: performance.now() - began });
		return kill.call(this, signal);
	};
	child.once("error", (error) => {
		call.error = error.code;
	});
	child.once("close", (exitCode, signal) => {
		Object.assign(call, { exitCode, signal, finishedMs: performance.now() - began });
	});
	return child;
};
syncBuiltinESMExports();

process.once("exit", () => {
	writeFileSync(process.env.ZINN_CODEX_TEST_TRACE, JSON.stringify(calls));
});
