/**
 * Lightweight English pluralization for the Arc CLI.
 *
 * Covers the common cases developers hit when naming resources:
 *   company  → companies
 *   category → categories
 *   status   → statuses
 *   address  → addresses
 *   person   → people
 *   child    → children
 *   bus      → buses
 *   box      → boxes
 *   quiz     → quizzes
 *   leaf     → leaves
 *   wolf     → wolves
 *
 * No external dependencies — designed to keep the CLI install-free.
 */

// Irregular nouns that can't be handled by suffix rules
const IRREGULARS: Record<string, string> = {
  person: "people",
  child: "children",
  man: "men",
  woman: "women",
  mouse: "mice",
  goose: "geese",
  tooth: "teeth",
  foot: "feet",
  ox: "oxen",
  datum: "data",
  medium: "media",
  index: "indices",
  matrix: "matrices",
  vertex: "vertices",
  criterion: "criteria",
};

// Words that are the same singular and plural
const UNCOUNTABLES = new Set([
  "sheep",
  "fish",
  "deer",
  "series",
  "species",
  "money",
  "rice",
  "information",
  "equipment",
  "media",
  "data",
]);

/**
 * Pluralize an English word.
 *
 * @param word - Singular noun (e.g. "company", "product", "person")
 * @returns Plural form (e.g. "companies", "products", "people")
 */
export function pluralize(word: string): string {
  const lower = word.toLowerCase();

  // Uncountable — return as-is
  if (UNCOUNTABLES.has(lower)) return word;

  // Irregular — preserve original casing of first char
  if (IRREGULARS[lower]) {
    const plural = IRREGULARS[lower];
    return word[0]! === word[0]?.toUpperCase()
      ? plural.charAt(0).toUpperCase() + plural.slice(1)
      : plural;
  }

  // Suffix rules (order matters — most specific first)

  // -fe / -f → -ves  (leaf → leaves, wolf → wolves, knife → knives)
  if (lower.endsWith("fe")) return `${word.slice(0, -2)}ves`;
  if (
    lower.endsWith("f") &&
    !lower.endsWith("ff") &&
    !lower.endsWith("roof") &&
    !lower.endsWith("chief") &&
    !lower.endsWith("belief")
  ) {
    return `${word.slice(0, -1)}ves`;
  }

  // consonant + y → -ies  (company → companies, category → categories)
  if (lower.endsWith("y") && !/[aeiou]y$/i.test(lower)) {
    return `${word.slice(0, -1)}ies`;
  }

  // -is → -es  (analysis → analyses, crisis → crises)
  if (lower.endsWith("is")) return `${word.slice(0, -2)}es`;

  // -us → -i  (only Latin-origin words, not status/bus/campus/virus)
  const LATIN_US_TO_I = new Set([
    "cactus",
    "stimulus",
    "focus",
    "fungus",
    "nucleus",
    "syllabus",
    "radius",
    "alumnus",
    "terminus",
    "bacillus",
  ]);
  if (LATIN_US_TO_I.has(lower)) return `${word.slice(0, -2)}i`;

  // -z at end → double z + -es  (quiz → quizzes, fez → fezzes)
  if (lower.endsWith("z") && !lower.endsWith("zz")) return `${word}zes`;

  // sibilant endings: -s, -ss, -sh, -ch, -x, -zz → -es
  if (/(?:s|sh|ch|x|zz)$/i.test(lower)) return `${word}es`;

  // -o → -es for common cases (hero → heroes, tomato → tomatoes)
  // but not for words ending in a vowel + o (radio → radios)
  if (lower.endsWith("o") && !/[aeiou]o$/i.test(lower)) return `${word}es`;

  // Default: just add -s
  return `${word}s`;
}
