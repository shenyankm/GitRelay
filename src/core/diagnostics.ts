import { stripVTControlCharacters } from "node:util";

/** Clean display-only diagnostics, never paths or Git data used by later operations. */
export function diagnosticMessage(error: unknown): string {
  return stripVTControlCharacters(error instanceof Error ? error.message : String(error))
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, " ")
    .slice(0, 4096);
}
