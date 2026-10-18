import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import readline from "node:readline";
import readlinePromises from "node:readline/promises";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";

function forbidden() {
	throw new Error("Forbidden discovery access");
}

for (const name of [
	"mkdir",
	"writeFile",
	"appendFile",
	"unlink",
	"rename",
	"rm",
	"mkdirSync",
	"writeFileSync",
	"appendFileSync",
	"unlinkSync",
	"renameSync",
	"rmSync",
	"createWriteStream"
]) {
	fs[name] = forbidden;
}
for (const name of ["mkdir", "writeFile", "appendFile", "unlink", "rename", "rm"]) {
	fsp[name] = forbidden;
}
function guardReads(module, names) {
	for (const name of names) {
		const original = module[name];
		module[name] = (path, ...args) => {
			const text = String(path);
			const store = process.env.ZINN_DIR;
			const isStore = store !== undefined && (text === store || text.startsWith(`${store}/`));
			if (isStore || /settings\.json|zinn\.local\.json|\.sqlite/.test(text)) {
				forbidden();
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
	"readFileSync",
	"existsSync",
	"statSync",
	"lstatSync",
	"accessSync",
	"openSync",
	"readdirSync"
]);
guardReads(fsp, ["readFile", "stat", "lstat", "access", "open", "readdir"]);
globalThis.fetch = forbidden;
http.request = http.get = https.request = https.get = forbidden;
net.connect = net.createConnection = forbidden;
readline.createInterface = readlinePromises.createInterface = forbidden;
childProcess.spawn =
	childProcess.spawnSync =
	childProcess.exec =
	childProcess.execSync =
	childProcess.execFile =
	childProcess.execFileSync =
		forbidden;
syncBuiltinESMExports();

const entryPoint = process.argv[2];
process.argv = [process.execPath, entryPoint, ...process.argv.slice(3)];
await import(pathToFileURL(entryPoint).href);
