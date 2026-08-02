export function quit(reason: string): never {
  console.error(reason);
  process.exit(1);
}
