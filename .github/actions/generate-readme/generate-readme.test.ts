import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  CONFIG_PATH,
  buildContext,
  detectKind,
  detectLicense,
  generate,
  parseConfig,
  readJson,
  releaseModules,
  versionKey,
} from "./generate-readme.ts";

const APACHE = "Apache License 2.0\nVersion 2.0, January 2004\n";
const GPL3 = "GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007\n";

const previousCwd = process.cwd();
const temporaryDirectories: string[] = [];

afterEach(() => {
  process.chdir(previousCwd);
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

/** Materialise a repository in a temp directory and chdir into it, as the generator expects. */
function repository(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), "readme-"));
  temporaryDirectories.push(directory);
  for (const [name, body] of Object.entries(files)) {
    const path = join(directory, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, "utf8");
  }
  process.chdir(directory);
  return directory;
}

function captureStderr(): { text: () => string } {
  let captured = "";
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    captured += String(chunk);
    return true;
  });
  return { text: () => captured };
}

async function build(
  files: Record<string, string>, repo = "owner/name", tag?: string,
): Promise<{ readme: string; tag: string; errors: string }> {
  repository(files);
  const errors = captureStderr();
  const result = await generate(repo, { tag, offline: true });
  return { ...result, errors: errors.text() };
}

function config(pairs: Record<string, string>): string {
  return Object.entries(pairs).map(([key, value]) => `${key}: ${value}`).join("\n") + "\n";
}

describe("config parsing", () => {
  function parse(body: string) {
    repository({ ".github/docs-config.yml": body });
    return parseConfig(CONFIG_PATH);
  }

  it("reads scalars, ignoring comments and quotes", () => {
    expect(parse("# a comment\nkind: \"addon\"\njava: '25'\n\nempty:\n"))
      .toEqual({ kind: "addon", java: "25" });
  });

  it("keeps everything after the first colon", () => {
    expect(parse("description: A library: for things\n").description)
      .toBe("A library: for things");
  });

  it("reads list values", () => {
    const parsed = parse("badges:\n  - stars\n  - downloads\nkind: generic\n");
    expect(parsed.badges).toEqual(["stars", "downloads"]);
    expect(parsed.kind).toBe("generic");
  });

  it("leaves an empty key without items absent", () => {
    expect(parse("badges:\n")).toEqual({});
  });
});

describe("kind detection", () => {
  function detect(files: Record<string, string>) {
    repository(files);
    return detectKind();
  }

  it("treats a plugin descriptor as an addon", () => {
    expect(detect({ "src/main/resources/plugin.yml": "name: X\n" })).toBe("addon");
  });

  it("finds a descriptor in a nested module", () => {
    expect(detect({ "core/src/main/resources/plugin.yml": "name: X\n" })).toBe("addon");
  });

  it("does not search build output", () => {
    expect(detect({ "build/src/main/resources/plugin.yml": "name: X\n" })).toBe("generic");
  });

  it("treats a gradle project as a java library", () => {
    expect(detect({ "gradle.properties": "display_name=X\n" })).toBe("java-library");
  });

  it("treats a package.json as an npm package", () => {
    expect(detect({ "package.json": '{"name": "x"}' })).toBe("npm-package");
  });

  it("falls back to generic", () => {
    expect(detect({ "CONTENT.md": "hi\n" })).toBe("generic");
  });
});

describe("section selection", () => {
  it("renders the addon sections", async () => {
    const { readme } = await build({
      ".github/docs-config.yml": config({ kind: "addon", bstats: "42" }),
      "CONTENT.md": "Addon prose.\n",
      LICENSE: GPL3,
    }, "owner/name", "v1.2.3");
    for (const expected of ["# name", "bStats", "## Requirements", "- Java", "Addon prose.",
      "## Developer API", "## Wiki", "## Discord",
      "licensed under the GNU General Public License v3.0"]) {
      expect(readme).toContain(expected);
    }
  });

  it("renders the gradle-plugin sections", async () => {
    const { readme } = await build({
      ".github/docs-config.yml": config({ kind: "gradle-plugin", description: "A plugin." }),
      "CONTENT.md": "Plugin prose.\n",
    }, "owner/name", "1.2.3");
    expect(readme).toContain("## What is name?");
    expect(readme).toContain('id "io.github.owner.name" version "1.2.3"');
    expect(readme).toContain("Once you have the plugin installed");
    expect(readme).not.toContain("## Requirements");
    expect(readme).not.toContain("## Discord");
  });

  it("renders the java-library sections", async () => {
    const { readme } = await build({
      ".github/docs-config.yml": config({ kind: "java-library", description: "A library." }),
    }, "owner/name", "1.2.3");
    expect(readme).toContain("## Usage in private projects");
    expect(readme).toContain("## Usage in public projects");
    expect(readme).toContain("<artifactId>name</artifactId>");
    expect(readme).not.toContain("## Modules");
  });

  it("renders the npm-package sections", async () => {
    const { readme } = await build({
      ".github/docs-config.yml": config({ kind: "npm-package" }),
      "package.json": '{"name": "@scope/tool", "description": "A tool.",'
        + ' "license": "MIT", "bin": {"tool": "dist/cli.js"}}',
    }, "owner/name", "1.0.0");
    expect(readme).toContain("# @scope/tool");
    expect(readme).toContain("npm install @scope/tool");
    expect(readme).toContain("It installs the `tool` command.");
    expect(readme).toContain("img.shields.io/npm/v/%40scope%2Ftool");
    expect(readme).toContain("License-MIT-blue");
  });

  it("renders the generic sections exactly", async () => {
    const { readme } = await build({
      ".github/docs-config.yml": config({ kind: "generic", title: "Thing", description: "Does things." }),
      "CONTENT.md": "Generic prose.\n",
      LICENSE: APACHE,
    });
    expect(readme).toBe("# Thing\n\nDoes things.\n\nGeneric prose.\n\n## License\n\n"
      + "[![Apache License 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)]"
      + "(LICENSE)\n");
  });

  it("lets config override the section order", async () => {
    const { readme } = await build({
      ".github/docs-config.yml": "kind: addon\nsections:\n  - title\n  - content\n",
      "CONTENT.md": "Only this.\n",
    });
    expect(readme).toBe("# name\n\nOnly this.\n");
  });

  it("rejects an unknown kind", async () => {
    await expect(build({ ".github/docs-config.yml": config({ kind: "nonsense" }) }))
      .rejects.toThrow(/unknown kind/);
  });

  it("rejects an unknown section", async () => {
    await expect(build({ ".github/docs-config.yml": "sections:\n  - nonsense\n" }))
      .rejects.toThrow(/no renderer registered/);
  });
});

describe("requirements", () => {
  it("defaults an addon to requiring the core plugin", async () => {
    const { readme } = await build({ ".github/docs-config.yml": config({ kind: "addon", java: "21" }) });
    expect(readme).toContain("- Java 21");
    expect(readme).toContain("- [Slimefun 5](https://github.com/Slimefun5/Slimefun5)");
  });

  it("lets configured requirements replace the defaults", async () => {
    const { readme } = await build({
      ".github/docs-config.yml": 'kind: addon\njava: "21"\nrequirements:\n'
        + "  - Java {{ java }}\n  - Paper {{ paper }}\n",
    });
    expect(readme).toContain("## Requirements\n- Java 21\n- Paper 1.16.* - 26.1.*");
    expect(readme).not.toContain("Slimefun 5](");
  });

  it("renders no heading for a kind without requirements", async () => {
    const { readme } = await build({
      ".github/docs-config.yml": "kind: generic\nsections:\n  - title\n  - requirements\n",
    });
    expect(readme).toBe("# name\n");
  });
});

describe("placeholders", () => {
  it("resolves known placeholders", async () => {
    const { readme, errors } = await build({
      ".github/docs-config.yml": config({ kind: "generic", description: "d" }),
      "CONTENT.md": "v{{ version }} of {{ repository }} under {{ license }}.\n",
      LICENSE: APACHE,
    }, "owner/name", "v2.1.0");
    expect(readme).toContain("v2.1.0 of owner/name under Apache License 2.0.");
    expect(errors).toBe("");
  });

  it("leaves an unknown placeholder visible and reports it", async () => {
    const { readme, errors } = await build({
      ".github/docs-config.yml": config({ kind: "generic" }),
      "CONTENT.md": "See {{ nonsense }}.\n",
    });
    expect(readme).toContain("See {{ nonsense }}.");
    expect(errors).toContain("unknown placeholder {{ nonsense }}");
  });

  it("leaves a known but empty placeholder visible and reports it", async () => {
    const { readme, errors } = await build({
      ".github/docs-config.yml": config({ kind: "generic" }),
      "CONTENT.md": "Logo: {{ logo }}.\n",
    });
    expect(readme).toContain("Logo: {{ logo }}.");
    expect(errors).toContain("placeholder {{ logo }} has no value");
  });

  it("leaves actions expressions alone", async () => {
    const { readme, errors } = await build({
      ".github/docs-config.yml": config({ kind: "generic" }),
      "CONTENT.md": "uses: ${{ github.repository }}\n",
    });
    expect(readme).toContain("${{ github.repository }}");
    expect(errors).toBe("");
  });

  it("lets a backslash escape a placeholder", async () => {
    const { readme, errors } = await build({
      ".github/docs-config.yml": config({ kind: "generic" }),
      "CONTENT.md": "Write \\{{ version }} to interpolate.\n",
    });
    expect(readme).toContain("Write {{ version }} to interpolate.");
    expect(errors).toBe("");
  });

  it("exposes config settings as placeholders", async () => {
    const { readme } = await build({
      ".github/docs-config.yml": config({ kind: "generic", paper: "1.21", description: "d" }),
      "CONTENT.md": "Targets Paper {{ paper }}.\n",
    });
    expect(readme).toContain("Targets Paper 1.21.");
  });

  it("covers the documented names", async () => {
    repository({ ".github/docs-config.yml": config({ kind: "java-library" }) });
    const table = (await buildContext("owner/name", { tag: "1.0.0", offline: true })).placeholders();
    for (const name of ["org", "repo", "repository", "tag", "version", "title", "description",
      "license", "license_slug", "artifact", "group", "plugin_id", "modules",
      "default_branch", "repo_url", "releases_url", "release_url", "release_date",
      "kind", "package_name", "package_version", "package_bin", "dependencies"]) {
      expect(table).toHaveProperty(name);
    }
  });
});

describe("metadata fallbacks", () => {
  it("takes title, description and group from gradle.properties", async () => {
    const { readme } = await build({
      ".github/docs-config.yml": config({ kind: "java-library" }),
      "gradle.properties": "display_name=Nice Name\nartifact_description=Does things.\n"
        + "artifact_group=io.github.other\n",
    }, "owner/name", "1.0.0");
    expect(readme).toContain("# Nice Name");
    expect(readme).toContain("## What is name?\n\nDoes things.");
    expect(readme).toContain("<groupId>io.github.other</groupId>");
  });

  it("falls back to the repository name", async () => {
    const { readme } = await build({
      ".github/docs-config.yml": config({ kind: "java-library" }),
    }, "owner/name", "1.0.0");
    expect(readme).toContain("# name");
    expect(readme).toContain("<groupId>io.github.owner</groupId>");
    expect(readme).not.toContain("## What is");
  });

  it("takes the description from package.json", async () => {
    const { readme } = await build({
      ".github/docs-config.yml": config({ kind: "generic" }),
      "package.json": '{"name": "tool", "description": "From npm."}',
    });
    expect(readme).toContain("From npm.");
  });

  it("falls back to the kind default description", async () => {
    const { readme } = await build({ ".github/docs-config.yml": config({ kind: "addon" }) });
    expect(readme).toContain("A Slimefun 5 Addon.");
  });

  it("takes the offline tag from the declared version", async () => {
    const { tag } = await build({
      ".github/docs-config.yml": config({ kind: "java-library" }),
      "gradle.properties": "artifact_version=3.4.5\n",
    });
    expect(tag).toBe("3.4.5");
  });

  it("takes the offline tag from the kind default without a version", async () => {
    const { tag } = await build({ ".github/docs-config.yml": config({ kind: "addon" }) });
    expect(tag).toBe("v1.0.0");
  });
});

describe("license detection", () => {
  function detect(files: Record<string, string>, overrides: Record<string, string> = {}) {
    repository(files);
    return detectLicense(overrides, readJson("package.json"));
  }

  it("prefers a license file over the default", () => {
    expect(detect({ LICENSE: APACHE }, { license_default: "MIT License" }))
      .toBe("Apache License 2.0");
  });

  it("prefers an explicit setting over the file", () => {
    expect(detect({ LICENSE: APACHE }, { license: "Custom" })).toBe("Custom");
  });

  it("uses the package.json SPDX id without a license file", () => {
    expect(detect({ "package.json": '{"license": "MIT"}' })).toBe("MIT License");
  });

  it("yields nothing with no source at all", () => {
    expect(detect({})).toBe("");
  });

  it("omits the section for a repository without a license", async () => {
    const { readme } = await build({
      ".github/docs-config.yml": config({ kind: "generic", description: "d" }),
    });
    expect(readme).not.toContain("## License");
  });

  it("keeps the kind default for an addon without a license file", async () => {
    const { readme } = await build({ ".github/docs-config.yml": config({ kind: "addon" }) });
    expect(readme).toContain("licensed under the GNU General Public License v3.0");
  });
});

describe("badges", () => {
  it("lets a configured list replace the kind default", async () => {
    const { readme } = await build({
      ".github/docs-config.yml": "kind: addon\nbadges:\n  - stars\n",
    });
    expect(readme).toContain("img.shields.io/github/stars/owner/name");
    expect(readme).not.toContain("img.shields.io/github/downloads");
  });

  it("shows the bstats badge only when configured", async () => {
    const without = await build({ ".github/docs-config.yml": config({ kind: "addon" }) });
    expect(without.readme).not.toContain("bStats");

    const withId = await build({
      ".github/docs-config.yml": config({ kind: "addon", bstats: "7", bstats_name: "Nice Name" }),
    });
    expect(withId.readme).toContain("https://bStats.org/plugin/bukkit/Nice%20Name/7");
  });

  it("needs a package.json for the npm badges", async () => {
    const { readme } = await build({
      ".github/docs-config.yml": "kind: generic\nbadges:\n  - npm-version\n  - stars\n",
    });
    expect(readme).not.toContain("shields.io/npm");
    expect(readme).toContain("shields.io/github/stars");
  });

  it("reports and skips an unknown badge", async () => {
    const { readme, errors } = await build({
      ".github/docs-config.yml": "kind: generic\nbadges:\n  - nonsense\n  - stars\n",
    });
    expect(errors).toContain("unknown badge 'nonsense'");
    expect(readme).toContain("shields.io/github/stars");
  });
});

describe("modules", () => {
  it("renders configured modules", async () => {
    const { readme } = await build({
      ".github/docs-config.yml": "kind: java-library\nmodules:\n  - api\n  - core\n",
    }, "owner/name", "1.0.0");
    expect(readme).toContain('githubImplementation "owner:name:1.0.0:all"');
    expect(readme).toContain('githubImplementation "owner:name:1.0.0:api"');
  });

  it("does not treat a single module as a module list", async () => {
    const { readme } = await build({
      ".github/docs-config.yml": "kind: java-library\nmodules:\n  - api\n",
    }, "owner/name", "1.0.0");
    expect(readme).not.toContain("## Modules");
  });

  it("takes classifiers from release assets", () => {
    const release = {
      assets: [{ name: "name-api.jar" }, { name: "name-core.jar" },
        { name: "name-sources.jar" }, { name: "name.jar" }],
    };
    expect(releaseModules(release, "name")).toEqual(["api", "core"]);
  });
});

describe("content", () => {
  it("drops the intro when there is no content", async () => {
    const { readme } = await build({
      ".github/docs-config.yml": config({ kind: "java-library", description: "A library." }),
    }, "owner/name", "1.0.0");
    expect(readme).not.toContain("Once you have it installed");
  });

  it("puts the intro before the prose", async () => {
    const { readme } = await build({
      ".github/docs-config.yml": config({ kind: "java-library", description: "A library." }),
      "CONTENT.md": "```java\nnew Thing();\n```\n",
    }, "owner/name", "1.0.0");
    expect(readme).toContain("Once you have it installed you can use it like so:\n\n```java");
  });
});

describe("version keys", () => {
  it("does not raise on non-numeric parts", () => {
    expect(versionKey("1.2.rc")).toEqual([1, 2, 0]);
  });

  it("orders numerically rather than lexically", () => {
    const sorted = ["1.10.0", "1.9.0"].sort((left, right) => {
      const a = versionKey(left);
      const b = versionKey(right);
      for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
        if (index >= a.length) return -1;
        if (index >= b.length) return 1;
        if (a[index] !== b[index]) return a[index] - b[index];
      }
      return 0;
    });
    expect(sorted).toEqual(["1.9.0", "1.10.0"]);
  });
});
