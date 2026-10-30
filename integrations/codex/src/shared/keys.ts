const KEY_SOURCE = "[A-Z][A-Z0-9]*-[1-9][0-9]{0,14}";
const KEY_EXACT = new RegExp(`^${KEY_SOURCE}$`, "i");

export function keyCandidates(text: string, anyCase = false): string[] {
  const out: string[] = [];
  const re = new RegExp(`(?<![A-Za-z0-9_-])(${KEY_SOURCE})(?![0-9A-Za-z])`, anyCase ? "gi" : "g");
  for (const m of text.matchAll(re)) {
    const k = m[1]!.toUpperCase();
    if (!out.includes(k)) {
      out.push(k);
    }
  }
  return out;
}

export const projectOf = (key: string) => key.slice(0, key.lastIndexOf("-"));

export function argvKeys(argv: readonly string[]) {
  const out: Array<string> = [];
  for (const t of argv) {
    if (t.startsWith("<text:")) {
      continue;
    }

    const bare = t.includes("#") ? t.slice(0, t.indexOf("#")) : t;
    const key = bare.toUpperCase();
    if (KEY_EXACT.test(bare) && !out.includes(key)) {
      out.push(key);
    }
  }

  return out;
}
