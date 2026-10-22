import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import readline from "node:readline";
import readlinePromises from "node:readline/promises";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function forbidden() {
	throw new Error("Forbidden discovery access");
}

// Block mutations everywhere, including paths outside the disposable store.
const mutations = [
	"appendFile",
	"chmod",
	"chown",
	"copyFile",
	"cp",
	"fchmod",
	"fchown",
	"fdatasync",
	"fsync",
	"ftruncate",
	"futimes",
	"lchmod",
	"lchown",
	"link",
	"lutimes",
	"mkdir",
	"mkdtemp",
	"rename",
	"rm",
	"rmdir",
	"symlink",
	"truncate",
	"unlink",
	"utimes",
	"write",
	"writeFile",
	"writev"
];
for (const name of mutations) {
	for (const module of [fs, fsp]) {
		for (const method of [name, `${name}Sync`]) {
			if (method in module) {
				module[method] = forbidden;
			}
		}
	}
}
fs.createWriteStream = forbidden;

function isProtectedPath(path) {
	if (typeof path === "number") {
		return false;
	}
	const text = resolve(path instanceof URL ? fileURLToPath(path) : String(path));
	const store = process.env.ZINN_DIR;
	const fromStore = store === undefined ? null : relative(resolve(store), text);
	const isStore =
		fromStore !== null &&
		!isAbsolute(fromStore) &&
		fromStore !== ".." &&
		!fromStore.startsWith("../") &&
		!fromStore.startsWith("..\\");
	return isStore || /settings\.json|zinn\.local\.json|\.sqlite/.test(text);
}

function checkFlags(flags = "r") {
	const writeFlags =
		fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND;
	const isReadOnly = typeof flags === "number" ? (flags & writeFlags) === 0 : ["r", "rs", "sr"].includes(flags);
	if (!isReadOnly) {
		forbidden();
	}
}

function guardReads(module, names) {
	for (const name of names) {
		const original = module[name];
		module[name] = (path, ...args) => {
			if (isProtectedPath(path)) {
				forbidden();
			}
			if (name === "open" || name === "openSync") {
				checkFlags(typeof args[0] === "function" ? undefined : args[0]);
			} else if (name === "readFile" || name === "readFileSync" || name === "createReadStream") {
				checkFlags(args[0]?.flag ?? args[0]?.flags);
			}
			return original(path, ...args);
		};
	}
}
guardReads(fs, [
	"readFile",
	"exists",
	"stat",
	"lstat",
	"access",
	"open",
	"readdir",
	"opendir",
	"readFileSync",
	"existsSync",
	"statSync",
	"lstatSync",
	"accessSync",
	"openSync",
	"readdirSync",
	"opendirSync",
	"createReadStream"
]);
guardReads(fsp, ["readFile", "stat", "lstat", "access", "open", "readdir", "opendir"]);
globalThis.fetch = forbidden;
http.request = http.get = https.request = https.get = forbidden;
net.connect = net.createConnection = net.Socket.prototype.connect = forbidden;
readline.createInterface = readlinePromises.createInterface = forbidden;
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
	childProcess[name] = forbidden;
}

if (process.versions.bun) {
	// Bun does not synchronize patched builtin defaults with named ESM imports.
	const { mock } = await import("bun:test");
	// Load these builtins before replacing their cached exports
	await import("bun:sqlite");
	await import("node:sqlite");
	for (const [name, module] of [
		["fs", fs],
		["fs/promises", fsp],
		["http", http],
		["https", https],
		["net", net],
		["readline", readline],
		["readline/promises", readlinePromises],
		["child_process", childProcess]
	]) {
		mock.module(`node:${name}`, () => ({ ...module, default: module }));
	}
	mock.module("bun:sqlite", () => ({ Database: forbidden }));
	mock.module("node:sqlite", () => ({ DatabaseSync: forbidden }));
	Bun.spawn = Bun.spawnSync = Bun.connect = Bun.listen = Bun.write = forbidden;
	const file = Bun.file;
	Bun.file = (path, ...args) => {
		if (isProtectedPath(path)) {
			forbidden();
		}
		const result = file(path, ...args);
		result.write = result.writer = result.delete = forbidden;
		return result;
	};
} else {
	const { registerHooks } = await import("node:module");
	// node:sqlite's named exports are not updated by syncBuiltinESMExports.
	registerHooks({
		load(url, context, nextLoad) {
			if (url === "node:sqlite") {
				return {
					format: "module",
					source: `const forbidden = ${forbidden.toString()};
            export { forbidden as DatabaseSync, forbidden as backup };
            export default { DatabaseSync: forbidden, backup: forbidden };`,
					shortCircuit: true
				};
			}
			return nextLoad(url, context);
		}
	});
	syncBuiltinESMExports();
}

const entryPoint = process.argv[2];
process.argv = [process.execPath, entryPoint, ...process.argv.slice(3)];
await import(pathToFileURL(entryPoint).href);
