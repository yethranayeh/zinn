export function standardizeProjectKey(key: string) {
  // TODO: maybe force latin characters only to prevent unexpected stuff from charaters like Ğ, İ, etc.
  return key.toUpperCase();
}

export function standardizeName(name: string) {
  return name.toLowerCase();
}

// A fixed locale keeps name order the same on every machine. Accented letters are placed next to their base letters.
const nameCollator = new Intl.Collator("en");

export function compareNames(left: { name: string }, right: { name: string }) {
  return nameCollator.compare(standardizeName(left.name), standardizeName(right.name));
}
