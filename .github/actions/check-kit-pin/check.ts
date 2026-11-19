/**
 * Refuses a drift run whose kit is not the one the repository under test pins.
 *
 * A repository adopts a kit commit by pinning it in its `repo.json`, and that pin is what
 * its own build and tests read. A drift run handed any other `kit_ref` judges the repository by
 * rules it never adopted, or lets it pass by rules it has since outgrown, so the two must agree.
 * The pin is found by the dependency's `id`, the kit repository's stable identity, because an
 * import name is the repository's own choice and another dependency may carry the kit's.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Dependency = { id?: unknown; importName?: unknown; commit?: unknown };

function dependenciesOf(repository: unknown): Dependency[] {
  if (typeof repository !== "object" || repository === null) return [];
  const dependencies = (repository as { dependencies?: unknown }).dependencies;
  if (!Array.isArray(dependencies)) return [];
  return dependencies.filter((entry): entry is Dependency => typeof entry === "object" && entry !== null);
}

function describeRef(kitRef: string): string {
  return kitRef === "" ? "kit_ref is empty, which runs the kit's default branch" : `kit_ref is ${kitRef}`;
}

function describePin(kitId: string, pin: Dependency): string {
  return typeof pin.importName === "string" ? `${kitId} (${pin.importName})` : kitId;
}

/** The refusal for a run of `kitRef` against a repository whose file reads `repository`, or undefined when they agree. */
export function kitPinRefusal(kitRef: string, kitId: string, repository: unknown): string | undefined {
  if (kitId === "") {
    return "no kit id was given, so the kit's pin cannot be told from any other dependency.";
  }
  const pins = dependenciesOf(repository).filter((entry) => entry.id === kitId);
  if (pins.length === 0) {
    return `${describeRef(kitRef)}, but repo.json pins no ${kitId}. Fix: pin the kit commit this repository adopts there, under the kit's id, and pass that commit as kit_ref.`;
  }
  if (pins.length > 1) {
    return `${describeRef(kitRef)}, but repo.json pins ${kitId} ${pins.length} times. Fix: keep one pin.`;
  }
  const pin = pins[0];
  if (typeof pin.commit !== "string" || pin.commit === "") {
    return `${describeRef(kitRef)}, but repo.json pins ${describePin(kitId, pin)} at no commit. Fix: give the pin its commit.`;
  }
  if (pin.commit !== kitRef) {
    return `${describeRef(kitRef)}, but repo.json pins ${describePin(kitId, pin)} at ${pin.commit}. Fix: move both to the same commit, kit_ref in the drift caller and the pin, in one change.`;
  }
  return undefined;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`the repo file ${path} cannot be read as JSON: ${(error as Error).message}`);
  }
}

function main(): number {
  const kitRef = process.env.KIT_REF ?? "";
  const kitId = process.env.KIT_ID ?? "";
  try {
    const refusal = kitPinRefusal(kitRef, kitId, readJson(process.env.REPOSITORY_FILE ?? ""));
    if (refusal !== undefined) {
      process.stdout.write(`::error::${refusal}\n`);
      return 1;
    }
    process.stdout.write(`The run uses the pinned ${kitId} ${kitRef}.\n`);
    return 0;
  } catch (error) {
    process.stdout.write(`::error::${(error as Error).message}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(main());
}
