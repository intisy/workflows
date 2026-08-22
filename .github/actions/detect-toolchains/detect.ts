import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Toolchain = "node" | "gradle" | "maven" | "python" | "cmake" | "make";
export type Target = "npm" | "github-gradle" | "maven" | "plugin-portal";

// Node runs first because a polyglot repo's npm build is what drives its gradle and TeaVM steps.
export const TOOLCHAIN_ORDER: readonly Toolchain[] = ["node", "gradle", "maven", "python", "cmake", "make"];
export const TARGET_ORDER: readonly Target[] = ["npm", "github-gradle", "maven", "plugin-portal"];

const GRADLE_ROOTS = [".", "java"] as const;
const GRADLE_MARKERS = ["settings.gradle", "settings.gradle.kts", "build.gradle", "build.gradle.kts"] as const;

const MARKERS: Record<"node" | "maven" | "python" | "cmake", readonly string[]> = {
  node: ["package.json"],
  maven: ["pom.xml"],
  python: ["pyproject.toml", "setup.py", "requirements.txt"],
  cmake: ["CMakeLists.txt"],
};

function has(rootDir: string, markers: readonly string[]): boolean {
  return markers.some((marker) => existsSync(join(rootDir, marker)));
}

/** Where the gradle build is rooted, or null when there is none. */
export function detectGradleRoot(rootDir: string): string | null {
  for (const dir of GRADLE_ROOTS) {
    if (GRADLE_MARKERS.some((marker) => existsSync(join(rootDir, dir, marker)))) return dir;
  }
  return null;
}

export function detectToolchains(rootDir: string): Toolchain[] {
  const found: Toolchain[] = [];
  const gradle = detectGradleRoot(rootDir) !== null;
  if (has(rootDir, MARKERS.node)) found.push("node");
  if (gradle) found.push("gradle");
  // A pom beside a gradle build is a leftover from before the migration, not a second build system.
  if (!gradle && has(rootDir, MARKERS.maven)) found.push("maven");
  if (has(rootDir, MARKERS.python)) found.push("python");
  if (has(rootDir, MARKERS.cmake)) found.push("cmake");
  // A Makefile beside a real build system is a helper, so make is the fallback rather than a peer.
  if (found.length === 0 && existsSync(join(rootDir, "Makefile"))) found.push("make");
  return found;
}

function gradleScripts(rootDir: string): string {
  let text = "";
  for (const dir of GRADLE_ROOTS) {
    for (const marker of GRADLE_MARKERS) {
      const path = join(rootDir, dir, marker);
      if (existsSync(path)) text += readFileSync(path, "utf-8");
    }
  }
  return text;
}

function publishesNpm(rootDir: string): boolean {
  const path = join(rootDir, "package.json");
  if (!existsSync(path)) return false;
  try {
    const pkg = JSON.parse(readFileSync(path, "utf-8")) as { name?: string; private?: boolean };
    return pkg.private !== true && typeof pkg.name === "string" && pkg.name.length > 0;
  } catch {
    return false;
  }
}

export function detectTargets(rootDir: string): Target[] {
  const found: Target[] = [];
  if (publishesNpm(rootDir)) found.push("npm");

  const scripts = gradleScripts(rootDir);
  if (/publishGithub|io[.]github[.]intisy[.]github/.test(scripts)) found.push("github-gradle");

  const ownsMaven = detectToolchains(rootDir).includes("maven");
  const pomPath = join(rootDir, "pom.xml");
  const pom = ownsMaven && existsSync(pomPath) ? readFileSync(pomPath, "utf-8") : "";
  if (/maven-publish/.test(scripts) || /distributionManagement/.test(pom)) found.push("maven");

  if (/com[.]gradle[.]plugin-publish|publishPlugins/.test(scripts)) found.push("plugin-portal");

  return TARGET_ORDER.filter((target) => found.includes(target));
}

function parseOverride<T extends string>(raw: string, known: readonly T[], label: string): T[] {
  const parts = raw.trim().split(/\s+/).filter((part) => part.length > 0);
  for (const part of parts) {
    if (!known.includes(part as T)) {
      throw new Error(`unknown ${label} "${part}"; known are ${known.join(", ")}`);
    }
  }
  return parts as T[];
}

export function outputLines(rootDir: string, override: string, targetsOverride: string): string[] {
  const toolchains = override.trim().length > 0
    ? parseOverride(override, TOOLCHAIN_ORDER, "toolchain")
    : detectToolchains(rootDir);
  const targets = targetsOverride.trim().length > 0
    ? parseOverride(targetsOverride, TARGET_ORDER, "target")
    : detectTargets(rootDir);

  const lines = [`toolchains=${toolchains.join(" ")}`, `targets=${targets.join(" ")}`];
  for (const tool of TOOLCHAIN_ORDER) lines.push(`${tool}=${toolchains.includes(tool) ? "true" : ""}`);
  for (const target of TARGET_ORDER) lines.push(`${target}=${targets.includes(target) ? "true" : ""}`);
  lines.push(`gradle_root=${toolchains.includes("gradle") ? (detectGradleRoot(rootDir) ?? "") : ""}`);
  return lines;
}

function flag(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : "";
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split("\\").join("/"))) {
  const root = flag("root") || ".";
  process.stdout.write(outputLines(root, flag("override"), flag("targets")).join("\n") + "\n");
}
