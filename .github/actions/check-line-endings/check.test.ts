import { describe, expect, it } from "vitest";
import { flippedBlobs, report } from "./check.ts";

/** Real `git ls-files --eol` output: three spaces-padded columns, then a TAB, then the path. */
function line(indexEol: string, path: string, attr = "-text"): string {
  return `i/${indexEol}\tw/lf\tattr/${attr}            \t${path}`;
}

describe("flippedBlobs", () => {
  it("finds nothing in a tree committed as LF", () => {
    const output = [line("lf", "src/main.c"), line("lf", "README.md")].join("\n");
    expect(flippedBlobs(output)).toEqual([]);
  });

  it("names a blob committed as CRLF", () => {
    const output = [line("lf", "src/main.c"), line("crlf", "examples/ABOUT.md")].join("\n");
    expect(flippedBlobs(output)).toEqual([{ path: "examples/ABOUT.md", indexEol: "crlf" }]);
  });

  it("names a blob with mixed endings, which is the half-converted case", () => {
    expect(flippedBlobs(line("mixed", "doc.md"))).toEqual([{ path: "doc.md", indexEol: "mixed" }]);
  });

  // i/none is how git reports a binary or empty file, and neither is a flip.
  it("leaves a binary or empty file alone", () => {
    const output = [line("none", "logo.png", "-text"), line("none", "empty.txt")].join("\n");
    expect(flippedBlobs(output)).toEqual([]);
  });

  it("exempts a path a pattern names", () => {
    const output = [line("crlf", "test/fixtures/crlf.txt"), line("crlf", "src/main.c")].join("\n");
    expect(flippedBlobs(output, "test/fixtures/*")).toEqual([
      { path: "src/main.c", indexEol: "crlf" },
    ]);
  });

  // A single star must not cross a separator, or one pattern silently exempts
  // a whole tree the author meant to keep checked.
  it("does not let a single star cross a separator", () => {
    expect(flippedBlobs(line("crlf", "test/deep/nested.txt"), "test/*")).toEqual([
      { path: "test/deep/nested.txt", indexEol: "crlf" },
    ]);
    expect(flippedBlobs(line("crlf", "test/deep/nested.txt"), "test/**")).toEqual([]);
  });

  it("takes several patterns separated by commas or spaces", () => {
    const output = [line("crlf", "a.bat"), line("crlf", "b.cmd"), line("crlf", "c.md")].join("\n");
    expect(flippedBlobs(output, "*.bat, *.cmd")).toEqual([{ path: "c.md", indexEol: "crlf" }]);
  });

  it("reads a path holding a space", () => {
    expect(flippedBlobs(line("crlf", "docs/a file.md"))).toEqual([
      { path: "docs/a file.md", indexEol: "crlf" },
    ]);
  });

  it("ignores a blank line and a line that is not a record", () => {
    const output = ["", "warning: something", line("crlf", "x.md")].join("\n");
    expect(flippedBlobs(output)).toEqual([{ path: "x.md", indexEol: "crlf" }]);
  });
});

/**
 * Copied byte for byte out of `git ls-files --eol`, because a parser tested
 * only against the helper above shares every mistake that helper makes. Two
 * shapes it never produces are here: the columns are space-padded rather than
 * tab-separated, and `attr/` is EMPTY for a file no attribute matches.
 */
const REAL_OUTPUT = [
  "i/lf    w/crlf  attr/                 \t.gitattributes",
  "i/mixed w/mixed attr/                 \tLICENSE",
  "i/crlf  w/crlf  attr/                 \tgradlew.bat",
  "i/-text w/-text attr/-text            \ttest/fixtures/tar/real-ustar.tar",
].join("\n");

describe("against real git output", () => {
  it("reads the padded columns and the empty attr column", () => {
    expect(flippedBlobs(REAL_OUTPUT)).toEqual([
      { path: "LICENSE", indexEol: "mixed" },
      { path: "gradlew.bat", indexEol: "crlf" },
    ]);
  });

  // w/crlf is what a checkout under core.autocrlf looks like and says nothing
  // about the blob, which is the whole reason this reads the index column.
  it("does not flag a file whose WORKING TREE is crlf", () => {
    expect(flippedBlobs(REAL_OUTPUT).some((flip) => flip.path === ".gitattributes")).toBe(false);
  });

  it("exempts the batch file a Windows wrapper legitimately ships", () => {
    expect(flippedBlobs(REAL_OUTPUT, "*.bat")).toEqual([{ path: "LICENSE", indexEol: "mixed" }]);
  });
});

describe("report", () => {
  it("says so when there is nothing to report", () => {
    expect(report([])).toEqual(["No committed blob holds CRLF."]);
  });

  it("annotates each file and names the fix once", () => {
    const lines = report([{ path: "a.md", indexEol: "crlf" }]);
    expect(lines[0]).toBe("::error file=a.md::committed with crlf line endings");
    expect(lines[1]).toContain("git add --renormalize .");
  });
});
