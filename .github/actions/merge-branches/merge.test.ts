import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = join(import.meta.dirname, "merge.sh");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function commit(cwd: string, file: string, body: string, message: string): void {
  writeFileSync(join(cwd, file), body);
  git(cwd, "add", "--all");
  git(cwd, "commit", "-m", message);
}

interface Fixture {
  work: string;
  remote: string;
}

// development holds the source branch; main additionally holds a generated README that development
// must never receive. Mirrors intisy/github-gradle.
function fixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), "merge-branches-"));
  const remote = join(base, "origin.git");
  mkdirSync(remote);
  git(remote, "init", "--bare", "--initial-branch=development");

  const work = join(base, "work");
  mkdirSync(work);
  git(work, "init", "--initial-branch=development");
  git(work, "config", "user.email", "test@example.com");
  git(work, "config", "user.name", "test");
  git(work, "remote", "add", "origin", remote);
  commit(work, "source.txt", "one\n", "init");
  git(work, "push", "-u", "origin", "development");

  git(work, "checkout", "-b", "main");
  commit(work, "README.md", "generated\n", "docs: generate readme");
  commit(work, "source.txt", "two\n", "feat: work done straight on main");
  git(work, "push", "-u", "origin", "main");

  git(work, "checkout", "development");
  return { work, remote };
}

function run(work: string, env: Record<string, string>): string {
  return execFileSync("bash", [SCRIPT], {
    cwd: work,
    encoding: "utf-8",
    env: { ...process.env, MODE: "merge", SYNC_BACK: "false", GENERATED_PATHS: "README.md", ...env },
  });
}

describe("merge-branches", () => {
  it("brings the target's source onto the source branch without its generated file", () => {
    const { work, remote } = fixture();

    run(work, { SOURCE: "development", TARGET: "main", SYNC_BACK: "true" });

    const clone = join(mkdtempSync(join(tmpdir(), "merge-verify-")), "clone");
    git(".", "clone", "--branch", "development", remote, clone);
    expect(git(clone, "show", "development:source.txt")).toBe("two");
    expect(existsSync(join(clone, "README.md"))).toBe(false);
  });

  it("leaves the target's generated file in place when merging forward", () => {
    const { work, remote } = fixture();
    git(work, "checkout", "development");
    commit(work, "feature.txt", "three\n", "feat: newer work on development");
    git(work, "push", "origin", "development");

    run(work, { SOURCE: "development", TARGET: "main" });

    const clone = join(mkdtempSync(join(tmpdir(), "merge-verify-")), "clone");
    git(".", "clone", "--branch", "main", remote, clone);
    expect(git(clone, "show", "main:feature.txt")).toBe("three");
    expect(git(clone, "show", "main:source.txt")).toBe("two");
    expect(git(clone, "show", "main:README.md")).toBe("generated");
  });

  // A repo whose README is produced on the SOURCE branch has to be able to turn the hold OFF.
  // Passing an empty value used to fall through to the default, so the file could never merge
  // forward and the target branch kept a stale copy of it forever.
  it("carries the source's generated file forward when the hold is cleared", () => {
    const { work, remote } = fixture();
    // With the hold cleared the first merge already syncs the file both ways, so development edits
    // main's copy rather than introducing an unrelated one.
    run(work, { SOURCE: "development", TARGET: "main", SYNC_BACK: "true", GENERATED_PATHS: "" });

    git(work, "checkout", "development");
    git(work, "pull", "--ff-only", "origin", "development");
    commit(work, "README.md", "rebuilt on development\n", "docs: rebuild the readme");
    git(work, "push", "origin", "development");

    run(work, { SOURCE: "development", TARGET: "main", GENERATED_PATHS: "" });

    const clone = join(mkdtempSync(join(tmpdir(), "merge-verify-")), "clone");
    git(".", "clone", "--branch", "main", remote, clone);
    expect(git(clone, "show", "main:README.md")).toBe("rebuilt on development");
  });

  it("refuses an unknown mode", () => {
    const { work } = fixture();
    expect(() => run(work, { SOURCE: "development", TARGET: "main", MODE: "rebase" })).toThrow();
  });

  it("keeps the target's generated file in overwrite mode", () => {
    const { work, remote } = fixture();
    git(work, "checkout", "development");
    commit(work, "source.txt", "four\n", "feat: divergent work");
    git(work, "push", "origin", "development");

    run(work, { SOURCE: "development", TARGET: "main", MODE: "overwrite" });

    const clone = join(mkdtempSync(join(tmpdir(), "merge-verify-")), "clone");
    git(".", "clone", "--branch", "main", remote, clone);
    expect(git(clone, "show", "main:source.txt")).toBe("four");
    expect(git(clone, "show", "main:README.md")).toBe("generated");
  });

  it("fails when a real conflict exists outside the generated paths", () => {
    const { work } = fixture();
    git(work, "checkout", "development");
    commit(work, "source.txt", "conflicting\n", "feat: same line as main");
    git(work, "push", "origin", "development");

    expect(() => run(work, { SOURCE: "development", TARGET: "main" })).toThrow();
  });

  it("is a no-op in overwrite mode when the target already contains the source", () => {
    const { work, remote } = fixture();

    run(work, { SOURCE: "development", TARGET: "main", MODE: "overwrite" });

    expect(git(work, "status", "--porcelain")).toBe("");
    const clone = join(mkdtempSync(join(tmpdir(), "merge-verify-")), "clone");
    git(".", "clone", "--branch", "main", remote, clone);
    expect(git(clone, "show", "main:README.md")).toBe("generated");
    expect(git(clone, "show", "main:source.txt")).toBe("two");
  });
});
