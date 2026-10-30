export const FREE_TEXT_FLAGS = ["--title", "--description", "--text", "--name"] as const;
export const MAX_ARG = 80;
export const redacted = (s: string) => `<text:len=${s.length}>`;
export function segments(command: string) {
  /** heheh */
  const segs: Array<Array<string>> = [];
  let words: Array<string> = [];
  let word = "";
  let inWord = false;

  const endWord = () => {
    if (inWord) {
      words.push(word);
    }
    word = "";
    inWord = false;
  };

  const endSeg = () => {
    endWord();
    if (words.length > 0) {
      segs.push(words);
    }
    words = [];
  };

  let i = 0;
  const n = command.length;
  const pendingHeredocs: Array<{
    delim: string;
    strip: boolean;
  }> = [];

  while (i < n) {
    const c = command[i]!;
    if (c === "\\" && i + 1 < n) {
      if (command[i + 1] === "\n") {
        i += 2;
        continue;
      }

      word += command[i + 1];
      inWord = true;
      i += 2;
      continue;
    }

    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      const stop = end === -1 ? n : end;
      word += command.slice(i + 1, stop);
      inWord = true;
      i = stop + 1;
      continue;
    }

    if (c === '"') {
      i++;

      while (i < n && command[i] !== '"') {
        if (command[i] === "\\" && i + 1 < n && '"\\$`\n'.includes(command[i + 1]!)) {
          word += command[i + 1];
          i += 2;
          continue;
        }
        word += command[i];
        i++;
      }

      i++;
      inWord = true;

      continue;
    }

    if (c === "#" && !inWord) {
      while (i < n && command[i] !== "\n") {
        i++;
      }

      continue;
    }

    if (c === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
      endWord();

      i += 2;
      let strip = false;
      if (command[i] === "-") {
        strip = true;
        i++;
      }

      while (i < n && (command[i] === " " || command[i] === "\t")) {
        i++;
      }

      let delim = "";
      while (i < n && !" \t\n;&|<>()".includes(command[i]!)) {
        const ch = command[i]!;
        if (ch !== "'" && ch !== '"' && ch !== "\\") {
          delim += ch;
        }
        i++;
      }

      if (delim !== "") {
        pendingHeredocs.push({ delim, strip });
      }

      continue;
    }

    if (c === "\n") {
      endSeg();
      i++;

      while (pendingHeredocs.length > 0) {
        const h = pendingHeredocs.shift()!;

        while (i < n) {
          const eol = command.indexOf("\n", i);
          const line = command.slice(i, eol === -1 ? n : eol);
          i = eol === -1 ? n : eol + 1;

          if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) {
            break;
          }
        }
      }
      continue;
    }

    if (c === "$" && command[i + 1] === "(") {
      endSeg();
      i += 2;
      continue;
    }

    if (";&|()`".includes(c)) {
      endSeg();
      i++;
      continue;
    }

    if (c === " " || c === "\t") {
      endWord();
      i++;
      continue;
    }

    word += c;
    inWord = true;
    i++;
  }
  endSeg();
  return segs;
}

export function redactArgv(argv: readonly string[]) {
  const out: Array<string> = [];
  let redactNext = false;

  for (const a of argv) {
    if (redactNext) {
      out.push(redacted(a));
      redactNext = false;
      continue;
    }

    const eq = a.indexOf("=");
    const flag = eq === -1 ? a : a.slice(0, eq);
    if ((FREE_TEXT_FLAGS as readonly string[]).includes(flag)) {
      if (eq === -1) {
        out.push(a);
        redactNext = true;
      } else {
        out.push(`${flag}=${redacted(a.slice(eq + 1))}`);
      }
      continue;
    }

    out.push(a.length > MAX_ARG ? redacted(a) : a);
  }
  return out;
}
