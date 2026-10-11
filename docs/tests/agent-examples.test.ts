import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("agent guide commands run against an isolated project", async () => {
	const directory = await mkdtemp(join(tmpdir(), "zinn-agent-examples-"));
	const cli = resolve(import.meta.dir, "../../packages/cli/index.ts");
	const guide = await Bun.file(resolve(import.meta.dir, "../public/agents.md")).text();
	const examples = [...guide.matchAll(/```sh\n([\s\S]*?)```/g)].map((match) => match[1]!).join("\n");
	const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
	const command = `${shellQuote(process.execPath)} ${shellQuote(cli)}`;
	try {
		const exampleProcess = Bun.spawn(["zsh", "-f", "-c", `set -e
${command} project create PROJECT --name "Agent example" --json
${command} task create PROJECT --title "Existing work" --json
${examples.replace(/^zinn /gm, `${command} `)}
`], {
			cwd: directory,
			env: { ...Bun.env, ZINN_DIR: directory },
			stdout: "pipe",
			stderr: "pipe"
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(exampleProcess.stdout).text(), new Response(exampleProcess.stderr).text(), exampleProcess.exited
		]);
		expect(stderr).toBe("");
		expect(exitCode).toBe(0);
		expect(stdout).toContain("PROJECT-1");
		expect(stdout).toContain("PROJECT-2");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
