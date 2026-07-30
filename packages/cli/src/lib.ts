export function quit(reason: string): never {
  console.error(reason);
  process.exit(1);
}

export function getArgs(nestingLevel: number = 0) {
  return process.argv.slice(2 + nestingLevel);
}
