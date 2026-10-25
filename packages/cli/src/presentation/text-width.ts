const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
const ZERO_WIDTH_CODE_POINT = /^[\p{Mark}\p{Default_Ignorable_Code_Point}\p{Cc}]$/u;
// The constructor permits Unicode-set matching with the ES2023 declaration target.
const RGI_EMOJI = new RegExp("^\\p{RGI_Emoji}$", "v");
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function graphemes(text: string) {
  return segmenter.segment(text);
}

function isWideEastAsian(codePoint: number) {
  // Unicode EastAsianWidth.txt lists the Hangul, CJK, kana, Yi and fullwidth blocks below.
  // https://www.unicode.org/Public/18.0.0/ucd/EastAsianWidth.txt
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff01 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1aff0 && codePoint <= 0x1afff) ||
    (codePoint >= 0x1b000 && codePoint <= 0x1b2ff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

export function displayWidth(text: string) {
  if (PRINTABLE_ASCII.test(text)) {
    return text.length;
  }

  let width = 0;
  for (const { segment } of graphemes(text)) {
    if ([...segment].every((point) => ZERO_WIDTH_CODE_POINT.test(point))) {
      continue;
    }

    if (RGI_EMOJI.test(segment) || isWideEastAsian(segment.codePointAt(0)!)) {
      width += 2;
    } else {
      width += 1;
    }
  }

  return width;
}
