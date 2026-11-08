/** A small XML plist reader for the types powermetrics writes. */

export type PlistValue = string | number | boolean | Date | PlistValue[] | PlistDict;

export type PlistDict = { [key: string]: PlistValue };

const DICT_OPEN = "<dict>";
const DICT_CLOSE = "</dict>";
const ARRAY_OPEN = "<array>";
const ARRAY_CLOSE = "</array>";
const KEY_OPEN = "<key>";
const KEY_CLOSE = "</key>";
const STRING_OPEN = "<string>";
const STRING_CLOSE = "</string>";
const INTEGER_OPEN = "<integer>";
const INTEGER_CLOSE = "</integer>";
const REAL_OPEN = "<real>";
const REAL_CLOSE = "</real>";
const DATE_OPEN = "<date>";
const DATE_CLOSE = "</date>";
const TRUE_TAG = "<true/>";
const FALSE_TAG = "<false/>";

type Reader = {
  text: string;
  index: number;
};

/** Parses the first plist dictionary in the text and refuses a document cut off before its end. */
export function parsePlist(text: string): PlistDict {
  const start = text.indexOf(DICT_OPEN);
  const end = text.lastIndexOf(DICT_CLOSE);
  if (start === -1 || end === -1 || end < start) {
    throw new Error("The plist has no complete dictionary");
  }
  const reader: Reader = {
    text: text.slice(start, end + DICT_CLOSE.length),
    index: 0,
  };
  const value = parseValue(reader);
  skipWhitespace(reader);
  if (reader.index !== reader.text.length) {
    throw new Error(`Unexpected text at offset ${reader.index}`);
  }
  if (!isPlistDict(value)) {
    throw new Error("The plist root is not a dictionary");
  }
  return value;
}

export function isPlistDict(value: PlistValue | undefined): value is PlistDict {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

/** Reads a dotted path, returning undefined when any step is missing. */
export function plistPath(value: PlistDict, dottedPath: string): PlistValue | undefined {
  let current: PlistValue = value;
  for (const part of dottedPath.split(".")) {
    if (!isPlistDict(current)) {
      return undefined;
    }
    const next: PlistValue | undefined = current[part];
    if (next === undefined) {
      return undefined;
    }
    current = next;
  }
  return current;
}

function parseValue(reader: Reader): PlistValue {
  skipWhitespace(reader);
  if (reader.text.startsWith(DICT_OPEN, reader.index)) {
    return parseDict(reader);
  }
  if (reader.text.startsWith(ARRAY_OPEN, reader.index)) {
    return parseArray(reader);
  }
  if (reader.text.startsWith(TRUE_TAG, reader.index)) {
    reader.index += TRUE_TAG.length;
    return true;
  }
  if (reader.text.startsWith(FALSE_TAG, reader.index)) {
    reader.index += FALSE_TAG.length;
    return false;
  }
  if (reader.text.startsWith(INTEGER_OPEN, reader.index)) {
    return parseNumber(reader, INTEGER_OPEN, INTEGER_CLOSE, true);
  }
  if (reader.text.startsWith(REAL_OPEN, reader.index)) {
    return parseNumber(reader, REAL_OPEN, REAL_CLOSE, false);
  }
  if (reader.text.startsWith(STRING_OPEN, reader.index)) {
    return readElementText(reader, STRING_OPEN, STRING_CLOSE);
  }
  if (reader.text.startsWith(DATE_OPEN, reader.index)) {
    const text = readElementText(reader, DATE_OPEN, DATE_CLOSE);
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) {
      throw new Error(`Not a plist date: ${text}`);
    }
    return date;
  }
  throw new Error(`Unsupported plist value at offset ${reader.index}`);
}

function parseDict(reader: Reader): PlistDict {
  reader.index += DICT_OPEN.length;
  const result: PlistDict = {};
  for (;;) {
    skipWhitespace(reader);
    if (reader.text.startsWith(DICT_CLOSE, reader.index)) {
      reader.index += DICT_CLOSE.length;
      return result;
    }
    if (!reader.text.startsWith(KEY_OPEN, reader.index)) {
      throw new Error(`Expected a plist key at offset ${reader.index}`);
    }
    const key = readElementText(reader, KEY_OPEN, KEY_CLOSE);
    result[key] = parseValue(reader);
  }
}

function parseArray(reader: Reader): PlistValue[] {
  reader.index += ARRAY_OPEN.length;
  const result: PlistValue[] = [];
  for (;;) {
    skipWhitespace(reader);
    if (reader.text.startsWith(ARRAY_CLOSE, reader.index)) {
      reader.index += ARRAY_CLOSE.length;
      return result;
    }
    result.push(parseValue(reader));
  }
}

function parseNumber(
  reader: Reader,
  openTag: string,
  closeTag: string,
  whole: boolean,
): number {
  const text = readElementText(reader, openTag, closeTag).trim();
  if (whole && !/^[+-]?[0-9]+$/.test(text)) {
    throw new Error(`Not a plist integer: ${text}`);
  }
  const value = Number(text);
  if (Number.isNaN(value)) {
    throw new Error(`Not a plist number: ${text}`);
  }
  return value;
}

function readElementText(reader: Reader, openTag: string, closeTag: string): string {
  if (!reader.text.startsWith(openTag, reader.index)) {
    throw new Error(`Expected ${openTag} at offset ${reader.index}`);
  }
  const valueStart = reader.index + openTag.length;
  const valueEnd = reader.text.indexOf(closeTag, valueStart);
  if (valueEnd === -1) {
    throw new Error(`Missing ${closeTag} at offset ${valueStart}`);
  }
  reader.index = valueEnd + closeTag.length;
  return decodeEntities(reader.text.slice(valueStart, valueEnd));
}

function skipWhitespace(reader: Reader): void {
  while (reader.index < reader.text.length && /\s/.test(reader.text[reader.index]!)) {
    reader.index++;
  }
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|quot|apos|lt|gt|amp);/gi, (_, entity: string) => {
    const named: Record<string, string> = { quot: '"', apos: "'", lt: "<", gt: ">", amp: "&" };
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    }
    return named[entity.toLowerCase()]!;
  });
}
