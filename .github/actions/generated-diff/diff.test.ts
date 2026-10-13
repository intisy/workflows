import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hasSubstantiveChange, optionsFromEnv } from "./diff.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

// A generated file whose first line is a run stamp and whose body is the data a
// reader wants. Mirrors daukle/manifest's plugins.json.
function generated(stamp: string, version: string): string {
  return `{\n  "generatedAt": "${stamp}",\n  "release": "${version}"\n}\n`;
}

function fixture(): string {
  const work = mkdtempSync(join(tmpdir(), "generated-diff-"));
  git(work, "init", "--initial-branch=main");
  git(work, "config", "user.email", "test@example.com");
  git(work, "config", "user.name", "test");
  // These cases compare bytes the revert restored, and a Windows checkout with
  // core.autocrlf on hands back CRLF for the LF they were written with.
  git(work, "config", "core.autocrlf", "false");
  writeFileSync(join(work, "plugins.json"), generated("2026-10-13T08:48:14.627Z", "1.4.2"));
  git(work, "add", "--all");
  git(work, "commit", "-m", "init");
  return work;
}

describe("hasSubstantiveChange", () => {
  it("reports nothing when the generator rewrote the file byte for byte", () => {
    const work = fixture();
    writeFileSync(join(work, "plugins.json"), generated("2026-10-13T08:48:14.627Z", "1.4.2"));

    expect(hasSubstantiveChange(work, { paths: ["plugins.json"], skipIfOnly: "generatedAt" }))
      .toBe(false);
    rmSync(work, { recursive: true, force: true });
  });

  it("reports nothing, and PUTS THE FILE BACK, when only the stamp moved", () => {
    const work = fixture();
    writeFileSync(join(work, "plugins.json"), generated("2026-10-13T08:59:43.326Z", "1.4.2"));

    expect(hasSubstantiveChange(work, { paths: ["plugins.json"], skipIfOnly: "generatedAt" }))
      .toBe(false);
    // The revert is the half a caller cannot see from the output: a left-behind
    // working tree would be committed by whatever runs next.
    expect(readFileSync(join(work, "plugins.json"), "utf-8"))
      .toBe(generated("2026-10-13T08:48:14.627Z", "1.4.2"));
    expect(git(work, "status", "--porcelain")).toBe("");
    rmSync(work, { recursive: true, force: true });
  });

  it("reports a change when the data moved with the stamp", () => {
    const work = fixture();
    writeFileSync(join(work, "plugins.json"), generated("2026-10-13T08:59:43.326Z", "1.5.0"));

    expect(hasSubstantiveChange(work, { paths: ["plugins.json"], skipIfOnly: "generatedAt" }))
      .toBe(true);
    rmSync(work, { recursive: true, force: true });
  });

  it("reports a change when the generator created a file", () => {
    const work = fixture();
    writeFileSync(join(work, "extra.json"), generated("2026-10-13T08:59:43.326Z", "1.4.2"));

    expect(hasSubstantiveChange(work, {
      paths: ["plugins.json", "extra.json"],
      skipIfOnly: "generatedAt",
    })).toBe(true);
    rmSync(work, { recursive: true, force: true });
  });

  it("reports a change when the generator deleted a file", () => {
    const work = fixture();
    rmSync(join(work, "plugins.json"));

    expect(hasSubstantiveChange(work, { paths: ["plugins.json"], skipIfOnly: "generatedAt" }))
      .toBe(true);
    rmSync(work, { recursive: true, force: true });
  });

  it("reports a change in a binary file, which carries no comparable lines at all", () => {
    const work = fixture();
    writeFileSync(join(work, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    git(work, "add", "--all");
    git(work, "commit", "-m", "add a binary");
    writeFileSync(join(work, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x02]));

    expect(hasSubstantiveChange(work, { paths: ["logo.png"], skipIfOnly: "generatedAt" }))
      .toBe(true);
    rmSync(work, { recursive: true, force: true });
  });

  it("reports any change when nothing is named to skip", () => {
    const work = fixture();
    writeFileSync(join(work, "plugins.json"), generated("2026-10-13T08:59:43.326Z", "1.4.2"));

    expect(hasSubstantiveChange(work, { paths: ["plugins.json"], skipIfOnly: "" })).toBe(true);
    rmSync(work, { recursive: true, force: true });
  });

  it("ignores a change outside the named paths, and leaves it alone", () => {
    const work = fixture();
    writeFileSync(join(work, "src.txt"), "hand written\n");

    expect(hasSubstantiveChange(work, { paths: ["plugins.json"], skipIfOnly: "generatedAt" }))
      .toBe(false);
    expect(readFileSync(join(work, "src.txt"), "utf-8")).toBe("hand written\n");
    rmSync(work, { recursive: true, force: true });
  });

  it("works in a subdirectory of the repository", () => {
    const work = fixture();
    mkdirSync(join(work, "nested"));
    writeFileSync(join(work, "nested", "data.json"), generated("a", "1.0.0"));
    git(work, "add", "--all");
    git(work, "commit", "-m", "add nested");
    writeFileSync(join(work, "nested", "data.json"), generated("b", "1.0.0"));

    expect(hasSubstantiveChange(work, {
      paths: ["nested/data.json"],
      skipIfOnly: "generatedAt",
    })).toBe(false);
    rmSync(work, { recursive: true, force: true });
  });
});

describe("optionsFromEnv", () => {
  it("reads a newline separated list and drops blank entries", () => {
    expect(optionsFromEnv({ PATHS: "a.json\n\n  b.json  \n", SKIP_IF_ONLY: " generatedAt " }))
      .toEqual({ paths: ["a.json", "b.json"], skipIfOnly: "generatedAt" });
  });

  it("defaults to no paths and nothing skipped", () => {
    expect(optionsFromEnv({})).toEqual({ paths: [], skipIfOnly: "" });
  });
});
