import { createRequire } from "node:module";

const TRUE_WORDS = ["true", "1", "yes", "on"];
const FALSE_WORDS = ["false", "0", "no", "off"];

/** Parse a user- or agent-supplied boolean. Throws on anything unrecognised instead of guessing false. */
export function parseBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  const word = String(value).trim().toLowerCase();
  if (TRUE_WORDS.includes(word)) return true;
  if (FALSE_WORDS.includes(word)) return false;
  throw new Error(`Invalid boolean "${value}". Use true or false.`);
}

/** Version from package.json (build/ and src/ both sit two levels below the package root). */
export function packageVersion(): string {
  const require = createRequire(import.meta.url);
  return require("../../package.json").version;
}
