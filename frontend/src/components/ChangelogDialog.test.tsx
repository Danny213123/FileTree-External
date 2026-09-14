import { describe, expect, it } from "vitest";
import { splitReleases } from "./ChangelogDialog";
import changelogMarkdown from "../../../CHANGELOG.md?raw";

describe("changelog parsing", () => {
  it("drops the preamble and keeps every release section", () => {
    const sections = splitReleases(changelogMarkdown);
    expect(sections.length).toBeGreaterThan(1);
    expect(sections.every((s) => s.startsWith("## "))).toBe(true);
    expect(sections.join("\n")).not.toContain("All notable changes to FileTree");
  });

  it("strips the horizontal rules used as separators between older entries", () => {
    expect(splitReleases(changelogMarkdown).some((s) => s.endsWith("---"))).toBe(false);
  });

  it("puts the newest release first, since only the first few are shown", () => {
    expect(splitReleases(changelogMarkdown)[0]).toMatch(/^## \[2\./);
  });

  it("ignores deeper headings so dated groups stay inside their release", () => {
    // An unreleased version logs work under `### YYYY-MM-DD` groups; those must
    // not split into sections of their own.
    const sections = splitReleases([
      "# Changelog",
      "",
      "preamble",
      "",
      "## [9.9.9] - Unreleased",
      "",
      "### 2026-01-02",
      "",
      "- did a thing",
      "",
      "## [9.9.8] - 2026-01-01",
      "",
      "- shipped",
      "",
      "---",
    ].join("\n"));

    expect(sections).toHaveLength(2);
    expect(sections[0]).toContain("### 2026-01-02");
    expect(sections[1]).toBe("## [9.9.8] - 2026-01-01\n\n- shipped");
  });
});
