/**
 * Reports committed blobs that hold CRLF.
 *
 * It reads `git ls-files --eol`, which reports the INDEX form of every tracked
 * file, because that is the only place the answer lives: a checkout under
 * core.autocrlf is CRLF on disk by design, so a working tree says nothing.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Flip = { path: string; indexEol: string };

const LINE = /^i\/(\S+)\s+w\/\S+\s+attr\/\S*\s*\t(.*)$/;

/** `*` stops at a separator, `**` does not, and everything else is literal. */
function patternToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index++;
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

export function parseExempt(exempt: string): RegExp[] {
  return exempt
    .split(/[\s,]+/)
    .filter((pattern) => pattern.length > 0)
    .map(patternToRegExp);
}

export function flippedBlobs(lsFilesEol: string, exempt: string = ""): Flip[] {
  const patterns = parseExempt(exempt);
  const flips: Flip[] = [];
  for (const line of lsFilesEol.split("\n")) {
    const match = LINE.exec(line.replace(/\r$/, ""));
    if (match === null) continue;
    const [, indexEol, path] = match;
    if (indexEol !== "crlf" && indexEol !== "mixed") continue;
    if (patterns.some((pattern) => pattern.test(path))) continue;
    flips.push({ path, indexEol });
  }
  return flips;
}

export function report(flips: Flip[]): string[] {
  if (flips.length === 0) return ["No committed blob holds CRLF."];
  const lines = flips.map(
    (flip) => `::error file=${flip.path}::committed with ${flip.indexEol} line endings`,
  );
  lines.push(
    `${flips.length} file(s) are committed with CRLF. Renormalise with` +
      ` "git add --renormalize ." and commit, or name a path in the exempt input.`,
  );
  return lines;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function flag(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : "";
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const flips = flippedBlobs(await readStdin(), flag("exempt"));
  process.stdout.write(report(flips).join("\n") + "\n");
  process.exit(flips.length === 0 ? 0 : 1);
}
