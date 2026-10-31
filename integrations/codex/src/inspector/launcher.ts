try {
  await import(new URL("./server.mjs", import.meta.url).href);
} catch (error) {
  if ((error as Error).name !== "AbortError") {
    process.stderr.write(`Zinn inspector setup: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
