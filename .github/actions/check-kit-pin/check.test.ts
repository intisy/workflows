import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { kitPinRefusal } from "./check.ts";

const PIN = "53d1a7f0c2b4e6a8d0f1e3c5b7a9d1f3e5c7b9a1";
const OTHER = "6bd2497b149fb552a53f77834c8110e72faf570b";
const KIT = "github:1426141679";
const CORE = "github:1455223370";

function repository(dependencies: unknown): unknown {
  return { format: 1, importName: "typescript", dependencies };
}

function pinning(commit: string): unknown {
  return repository([
    { id: CORE, importName: "core", commit: OTHER },
    { id: KIT, importName: "conformance", commit },
  ]);
}

describe("kitPinRefusal", () => {
  it("passes a run whose kit_ref is the commit the repository pins its kit at", () => {
    expect(kitPinRefusal(PIN, KIT, pinning(PIN))).toBeUndefined();
  });

  it("refuses a run whose kit_ref differs from the pin, naming both", () => {
    const refusal = kitPinRefusal(OTHER, KIT, pinning(PIN));

    expect(refusal).toContain(`kit_ref is ${OTHER}`);
    expect(refusal).toContain(`pins ${KIT} (conformance) at ${PIN}`);
  });

  it("refuses an empty kit_ref, which would run the kit's default branch, naming the pin", () => {
    const refusal = kitPinRefusal("", KIT, pinning(PIN));

    expect(refusal).toContain("kit_ref is empty");
    expect(refusal).toContain(PIN);
  });

  it("refuses a branch name, since only the pinned commit is the kit the repository adopted", () => {
    expect(kitPinRefusal("main", KIT, pinning(PIN))).toContain("kit_ref is main");
  });

  it("refuses a repository that pins no kit at all", () => {
    const refusal = kitPinRefusal(PIN, KIT, repository([{ id: CORE, importName: "core", commit: OTHER }]));

    expect(refusal).toContain(`pins no ${KIT}`);
  });

  it("reads a missing or malformed dependency list as pinning no kit", () => {
    expect(kitPinRefusal(PIN, KIT, repository(undefined))).toContain(`pins no ${KIT}`);
    expect(kitPinRefusal(PIN, KIT, repository("conformance"))).toContain(`pins no ${KIT}`);
    expect(kitPinRefusal(PIN, KIT, "not an object")).toContain(`pins no ${KIT}`);
  });

  it("refuses a repository that pins the kit twice, since either pin could be the one meant", () => {
    const refusal = kitPinRefusal(
      PIN,
      KIT,
      repository([
        { id: KIT, importName: "conformance", commit: PIN },
        { id: KIT, importName: "exam", commit: OTHER },
      ]),
    );

    expect(refusal).toContain(`pins ${KIT} 2 times`);
  });

  it("refuses a pin that carries no commit", () => {
    expect(kitPinRefusal(PIN, KIT, repository([{ id: KIT, importName: "conformance" }]))).toContain(
      `pins ${KIT} (conformance) at no commit`,
    );
  });

  it("finds the kit by its id under whatever import name the repository gives it", () => {
    expect(kitPinRefusal(PIN, KIT, repository([{ id: KIT, importName: "exam", commit: PIN }]))).toBeUndefined();
  });

  it("does not take a dependency named conformance whose id is another repository's for the kit", () => {
    const impostor = repository([{ id: "github:999", importName: "conformance", commit: PIN }]);

    expect(kitPinRefusal(PIN, KIT, impostor)).toContain(`pins no ${KIT}`);
  });

  it("refuses to judge without the kit's id, since no pin could then be told apart", () => {
    expect(kitPinRefusal(PIN, "", pinning(PIN))).toContain("no kit id");
  });
});

describe("the check run as the step runs it", () => {
  function run(kitRef: string, repositoryJson: string, kitId: string): { status: number; output: string } {
    const work = mkdtempSync(join(tmpdir(), "check-kit-pin-"));
    writeFileSync(join(work, "repo.json"), repositoryJson);
    try {
      const output = execFileSync(process.execPath, [join(import.meta.dirname, "check.ts")], {
        env: { ...process.env, KIT_REF: kitRef, REPOSITORY_FILE: join(work, "repo.json"), KIT_ID: kitId },
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { status: 0, output };
    } catch (error) {
      const failed = error as { status: number; stdout: string; stderr: string };
      return { status: failed.status, output: failed.stdout + failed.stderr };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  it("exits 0 and says so for the pinned commit", () => {
    const result = run(PIN, JSON.stringify(pinning(PIN)), KIT);

    expect(result.status).toBe(0);
    expect(result.output).toContain(`the pinned ${KIT} ${PIN}`);
  });

  it("exits 1 with an error annotation naming both commits for another one", () => {
    const result = run(OTHER, JSON.stringify(pinning(PIN)), KIT);

    expect(result.status).toBe(1);
    expect(result.output).toMatch(/^::error::/m);
    expect(result.output).toContain(OTHER);
    expect(result.output).toContain(PIN);
  });

  it("exits 1 for a repository file that is not JSON, and for a run given no kit id", () => {
    expect(run(PIN, "{", KIT).status).toBe(1);
    expect(run(PIN, JSON.stringify(pinning(PIN)), "").status).toBe(1);
  });
});
