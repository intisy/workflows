import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

export type Mode = "merge" | "overwrite";

export interface Options {
  source: string;
  target: string;
  mode: Mode;
  syncBack: boolean;
  /** Paths always resolved to the branch being merged INTO; empty holds nothing back. */
  generatedPaths: string[];
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

/** Runs git for its exit status alone, so a expected failure is not an exception. */
function gitSucceeds(cwd: string, ...args: string[]): boolean {
  try {
    execFileSync("git", args, { cwd, encoding: "utf-8", stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function resolveRef(cwd: string, branch: string): string {
  return gitSucceeds(cwd, "rev-parse", "--verify", "--quiet", `origin/${branch}`)
    ? `origin/${branch}`
    : branch;
}

function remoteHasBranch(cwd: string, branch: string): boolean {
  return gitSucceeds(cwd, "ls-remote", "--exit-code", "--heads", "origin", branch);
}

/**
 * A --no-commit merge leaves HEAD at the pre-merge tip, so the branch's own prior state is what
 * HEAD: resolves to. That is what lets a generated path be restored without recording it first.
 */
function restoreGenerated(cwd: string, paths: string[]): void {
  for (const path of paths) {
    if (gitSucceeds(cwd, "cat-file", "-e", `HEAD:${path}`)) {
      git(cwd, "checkout", "HEAD", "--", path);
    } else {
      git(cwd, "rm", "-q", "--cached", "--ignore-unmatch", "--", path);
      rmSync(join(cwd, path), { force: true });
    }
  }
}

function mergeInto(cwd: string, from: string, onto: string, mode: Mode, generatedPaths: string[]): void {
  console.log(`::group::merge ${from} into ${onto}`);

  if (!remoteHasBranch(cwd, onto)) {
    git(cwd, "checkout", "-b", onto, from);
    git(cwd, "push", "origin", onto);
    console.log(`created ${onto} from ${from}`);
    console.log("::endgroup::");
    return;
  }

  git(cwd, "checkout", onto);

  if (mode === "overwrite") {
    git(cwd, "merge", "-s", "ours", "--no-commit", "--allow-unrelated-histories", from);
  } else if (!gitSucceeds(cwd, "merge", "--no-commit", "--no-ff", from)
    && !gitSucceeds(cwd, "rev-parse", "-q", "--verify", "MERGE_HEAD")) {
    throw new Error(`merge of ${from} into ${onto} could not start`);
  }

  if (!gitSucceeds(cwd, "rev-parse", "-q", "--verify", "MERGE_HEAD")) {
    console.log(`already up to date: ${onto} contains ${from}`);
    console.log("::endgroup::");
    return;
  }

  // read-tree rewrites the working tree unconditionally, so it must not run for a merge that never
  // started.
  if (mode === "overwrite") {
    git(cwd, "read-tree", "--reset", "-u", from);
  }

  restoreGenerated(cwd, generatedPaths);

  const unresolved = git(cwd, "diff", "--name-only", "--diff-filter=U");
  if (unresolved !== "") {
    throw new Error(
      `merge of ${from} into ${onto} left conflicts outside the generated paths:\n${unresolved}`,
    );
  }

  git(cwd, "commit", "--no-edit", "-m", `chore: merge ${from} into ${onto}`);
  git(cwd, "push", "origin", onto);
  console.log("::endgroup::");
}

export function mergeBranches(cwd: string, options: Options): void {
  git(cwd, "fetch", "--force", "--tags", "origin");

  mergeInto(cwd, resolveRef(cwd, options.source), options.target, options.mode, options.generatedPaths);

  if (!options.syncBack) {
    return;
  }
  if (!remoteHasBranch(cwd, options.source)) {
    console.log(`no ${options.source} branch to sync back to`);
    return;
  }
  // overwrite means make the target look like the source, so the reverse leg is always a plain merge.
  mergeInto(cwd, resolveRef(cwd, options.target), options.source, "merge", options.generatedPaths);
}

/**
 * @remarks An UNSET generated-paths value takes the default, but an explicitly EMPTY one means
 * "hold nothing": a repo whose generated file is produced on the SOURCE branch needs it to merge
 * forward like any other file.
 */
export function optionsFromEnv(env: NodeJS.ProcessEnv): Options {
  const mode = env.MODE ?? "merge";
  if (mode !== "merge" && mode !== "overwrite") {
    throw new Error(`mode must be merge or overwrite, got '${mode}'`);
  }
  return {
    source: env.SOURCE ?? "",
    target: env.TARGET ?? "",
    mode,
    syncBack: env.SYNC_BACK === "true",
    generatedPaths: (env.GENERATED_PATHS ?? "README.md").split("\n")
      .map(path => path.trim())
      .filter(path => path !== ""),
  };
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  try {
    mergeBranches(process.cwd(), optionsFromEnv(process.env));
  } catch (error) {
    console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
