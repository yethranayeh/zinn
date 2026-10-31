try {
  await import(new URL("./server.mjs", import.meta.url).href);
} catch (error) {
  process.stderr.write(`Zinn inspector setup: ${(error as Error).message}\n`);
  process.exitCode = 1;
}
