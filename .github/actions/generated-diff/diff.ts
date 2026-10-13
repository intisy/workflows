import { execFileSync } from "node:child_process";

export interface Options {
  /** Paths to examine; a path outside this list is neither reported nor reverted. */
  paths: string[];
  /**
   * A generator that stamps its own run into its output changes those files on
   * every run, so a scheduled job committing whatever it wrote would commit
   * forever. When every changed line carries this text, the change is that
   * stamp and nothing else, and the paths are put back.
   */
  skipIfOnly: string;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function stagedStatuses(cwd: string, paths: string[]): string[] {
  const output = git(cwd, "diff", "--cached", "--name-status", "--", ...paths);
  return output === "" ? [] : output.split("\n");
}

function isModification(status: string): boolean {
  return status.startsWith("M");
}

/** The +/- lines of a diff, without the +++/--- file headers that share the prefix. */
function changedLines(cwd: string, paths: string[]): string[] {
  return git(cwd, "diff", "--cached", "-U0", "--", ...paths)
    .split("\n")
    .filter(line => /^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line));
}

function revert(cwd: string, paths: string[]): void {
  git(cwd, "reset", "--quiet", "--", ...paths);
  git(cwd, "checkout", "--", ...paths);
}

/**
 * Whether the named paths hold a change worth committing, having staged them so
 * a file the generator created counts as one.
 *
 * @implNote a status other than `M` is reported without reading the diff. An
 * added, deleted or renamed generated file is substantive whatever its lines
 * say, and it is also the case `revert` cannot undo: `git checkout --` has
 * nothing to restore for a path that is not in HEAD.
 */
export function hasSubstantiveChange(cwd: string, options: Options): boolean {
  // --force so a repository that gitignores its generated file is still seen to
  // have changed it, which is the case readme.yml carries the same flag for.
  git(cwd, "add", "--all", "--force", "--", ...options.paths);

  const statuses = stagedStatuses(cwd, options.paths);
  if (statuses.length === 0) return false;
  if (!statuses.every(isModification)) return true;
  if (options.skipIfOnly === "") return true;

  const lines = changedLines(cwd, options.paths);
  // A binary file reports a modification and no lines at all, and "every line
  // carries the stamp" is vacuously true of none of them.
  if (lines.length === 0) return true;
  if (!lines.every(line => line.includes(options.skipIfOnly))) return true;

  revert(cwd, options.paths);
  return false;
}

export function optionsFromEnv(env: NodeJS.ProcessEnv): Options {
  return {
    paths: (env.PATHS ?? "").split("\n").map(path => path.trim()).filter(path => path !== ""),
    skipIfOnly: (env.SKIP_IF_ONLY ?? "").trim(),
  };
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const options = optionsFromEnv(process.env);
  if (options.paths.length === 0) {
    console.log("::error::generated-diff needs at least one path");
    process.exit(1);
  }
  console.log(`changed=${hasSubstantiveChange(process.cwd(), options)}`);
}
