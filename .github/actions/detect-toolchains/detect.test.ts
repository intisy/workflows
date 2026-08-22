import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectGradleRoot, detectTargets, detectToolchains, outputLines } from "./detect.ts";

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "detect-"));
  for (const [path, body] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

describe("detectToolchains", () => {
  it("detects a plain node repo", () => {
    expect(detectToolchains(repo({ "package.json": "{}" }))).toEqual(["node"]);
  });

  it("detects a polyglot repo as both, node first", () => {
    const dir = repo({ "package.json": "{}", "settings.gradle": "" });
    expect(detectToolchains(dir)).toEqual(["node", "gradle"]);
  });

  it("detects gradle nested under java", () => {
    const dir = repo({ "package.json": "{}", "java/settings.gradle": "" });
    expect(detectToolchains(dir)).toEqual(["node", "gradle"]);
  });

  it("detects cmake", () => {
    expect(detectToolchains(repo({ "CMakeLists.txt": "" }))).toEqual(["cmake"]);
  });

  it("detects python from any of its three markers", () => {
    for (const marker of ["pyproject.toml", "setup.py", "requirements.txt"]) {
      expect(detectToolchains(repo({ [marker]: "" }))).toEqual(["python"]);
    }
  });

  it("detects maven alone", () => {
    expect(detectToolchains(repo({ "pom.xml": "<project/>" }))).toEqual(["maven"]);
  });

  // slimefun/addons/Networks carries a 2024 pom.xml beside the gradle build its CI actually runs.
  it("treats a pom beside a gradle build as a leftover", () => {
    const dir = repo({ "settings.gradle.kts": "", "build.gradle.kts": "", "pom.xml": "<project/>" });
    expect(detectToolchains(dir)).toEqual(["gradle"]);
  });

  it("uses make only when nothing else matched", () => {
    expect(detectToolchains(repo({ Makefile: "" }))).toEqual(["make"]);
    expect(detectToolchains(repo({ Makefile: "", "package.json": "{}" }))).toEqual(["node"]);
  });

  it("returns nothing for a repo with no build system", () => {
    expect(detectToolchains(repo({ "LICENSE": "" }))).toEqual([]);
  });
});

describe("detectGradleRoot", () => {
  it("prefers the repository root", () => {
    expect(detectGradleRoot(repo({ "settings.gradle": "", "java/settings.gradle": "" }))).toBe(".");
  });

  it("falls back to java", () => {
    expect(detectGradleRoot(repo({ "java/build.gradle": "" }))).toBe("java");
  });

  it("is null when there is no gradle build", () => {
    expect(detectGradleRoot(repo({ "package.json": "{}" }))).toBe(null);
  });
});

describe("detectTargets", () => {
  it("detects npm for a public package", () => {
    expect(detectTargets(repo({ "package.json": '{"name":"thing"}' }))).toContain("npm");
  });

  it("does not detect npm for a private package", () => {
    expect(detectTargets(repo({ "package.json": '{"name":"thing","private":true}' }))).not.toContain("npm");
  });

  it("does not detect npm for a package with no name", () => {
    expect(detectTargets(repo({ "package.json": "{}" }))).not.toContain("npm");
  });

  it("detects github-gradle from the publish task", () => {
    const dir = repo({ "build.gradle": "task x { dependsOn publishGithub }" });
    expect(detectTargets(dir)).toContain("github-gradle");
  });

  it("detects the plugin portal", () => {
    const dir = repo({ "build.gradle": "plugins { id 'com.gradle.plugin-publish' }" });
    expect(detectTargets(dir)).toContain("plugin-portal");
  });

  it("detects maven from the gradle plugin and from a pom", () => {
    const gradleDir = repo({ "build.gradle": "apply plugin: 'maven-publish'\npublishing { repositories { maven { url = 'https://example.com' } } }" });
    expect(detectTargets(gradleDir)).toContain("maven");
    expect(detectTargets(repo({ "pom.xml": "<distributionManagement/>" }))).toContain("maven");
  });

  // A leftover pom must not make a gradle repo look like it publishes to a maven repository.
  it("ignores a pom's distributionManagement when gradle owns the build", () => {
    const dir = repo({ "settings.gradle.kts": "", "pom.xml": "<distributionManagement/>" });
    expect(detectTargets(dir)).not.toContain("maven");
  });

  it("finds a gradle target under java too", () => {
    const dir = repo({ "java/build.gradle": "publishGithub" });
    expect(detectTargets(dir)).toContain("github-gradle");
  });

  it("does not treat a plugin consumer as a github-gradle publisher", () => {
    const dir = repo({ "build.gradle.kts": 'plugins { id("io.github.intisy.github-gradle") version "1.8.3" }' });
    expect(detectTargets(dir)).not.toContain("github-gradle");
  });

  it("does not treat a malformed package.json as an npm target", () => {
    expect(detectTargets(repo({ "package.json": "not json" }))).not.toContain("npm");
  });

  it("does not treat the maven-publish plugin alone as a maven target", () => {
    const dir = repo({ "build.gradle": "plugins { id 'maven-publish' }\npublishing { publications { } }" });
    expect(detectTargets(dir)).not.toContain("maven");
  });

  it("treats a declared publishing repository as a maven target", () => {
    const dir = repo({ "build.gradle": "publishing { repositories { maven { url = 'https://example.com' } } }" });
    expect(detectTargets(dir)).toContain("maven");
  });

  it("ignores a dependency repositories block trailing the publishing block", () => {
    const dir = repo({
      "build.gradle": [
        "publishing { publications { create('x') { } } }",
        "repositories { mavenCentral() }",
      ].join("\n"),
    });
    expect(detectTargets(dir)).not.toContain("maven");
  });

  it("does not join a publishing block in one script to a repositories block in another", () => {
    const dir = repo({
      "settings.gradle": "publishing { publications { } }",
      "build.gradle": "repositories { mavenCentral() }",
    });
    expect(detectTargets(dir)).not.toContain("maven");
  });
});

describe("outputLines", () => {
  it("emits one key=value per line with a boolean per toolchain", () => {
    const lines = outputLines(repo({ "package.json": '{"name":"thing"}' }), "", "");
    expect(lines).toContain("toolchains=node");
    expect(lines).toContain("node=true");
    expect(lines).toContain("gradle=");
    expect(lines).toContain("gradle_root=");
    expect(lines).toContain("targets=npm");
  });

  it("does not emit maven twice when it is both a toolchain and a target", () => {
    const lines = outputLines(repo({ "pom.xml": "<distributionManagement/>" }), "", "");
    expect(lines.filter((line) => line.startsWith("maven="))).toHaveLength(1);
    expect(lines).toContain("maven-target=true");
  });

  it("honours an explicit toolchain override", () => {
    const lines = outputLines(repo({ "package.json": "{}" }), "cmake make", "");
    expect(lines).toContain("toolchains=cmake make");
    expect(lines).toContain("cmake=true");
    expect(lines).toContain("node=");
  });

  it("honours an explicit target override", () => {
    const lines = outputLines(repo({ "package.json": '{"name":"thing"}' }), "", "plugin-portal");
    expect(lines).toContain("targets=plugin-portal");
    expect(lines).toContain("plugin-portal=true");
    expect(lines).toContain("npm=");
  });

  it("rejects an unknown toolchain in an override", () => {
    expect(() => outputLines(repo({}), "rust", "")).toThrow(/rust/);
  });

  it("reports the gradle root when gradle is present", () => {
    expect(outputLines(repo({ "java/settings.gradle": "" }), "", "")).toContain("gradle_root=java");
    expect(outputLines(repo({ "settings.gradle": "" }), "", "")).toContain("gradle_root=.");
  });

  it("accepts none as an explicit empty override", () => {
    const lines = outputLines(repo({ "package.json": '{"name":"thing"}' }), "none", "none");
    expect(lines).toContain("toolchains=");
    expect(lines).toContain("targets=");
    expect(lines).toContain("node=");
  });
});
