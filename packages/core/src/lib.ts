export function standardizeProjectKey(key: string) {
  // TODO: maybe force latin characters only to prevent unexpected stuff from charaters like Ğ, İ, etc.
  return key.toUpperCase();
}
