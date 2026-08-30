import { describe, expect, it } from "vitest";
import { compileNameMatcher, parseSearchTerms } from "./search";

describe("tokenized search", () => {
  it("parses phrases, exclusions, aliases, and field scopes", () => {
    expect(parseSearchTerms('summer "annual report" -backup name:final in:archive ext:pdf type:document')).toEqual([
      { value: "summer", field: "any", excluded: false },
      { value: "annual report", field: "any", excluded: false },
      { value: "backup", field: "any", excluded: true },
      { value: "final", field: "name", excluded: false },
      { value: "archive", field: "path", excluded: false },
      { value: "pdf", field: "ext", excluded: false },
      { value: "document", field: "type", excluded: false },
    ]);
  });

  it("ANDs plain terms and excludes unwanted matches", () => {
    const matcher = compileNameMatcher("summer 2024 -backup", false);
    expect(matcher.test("Summer Vacation 2024.mp4", "D:\\Media\\Summer Vacation 2024.mp4", { dir: false, extension: "mp4" })).toBe(true);
    expect(matcher.test("Summer Backup 2024.mp4", "D:\\Media\\Summer Backup 2024.mp4", { dir: false, extension: "mp4" })).toBe(false);
    expect(matcher.test("Summer Vacation.mp4", "D:\\Media\\Summer Vacation.mp4", { dir: false, extension: "mp4" })).toBe(false);
  });

  it("supports phrases, scoped fields, categories, and wildcards", () => {
    const matcher = compileNameMatcher('"annual report" path:finance ext:p?f type:document', false);
    expect(matcher.test("Annual Report.pdf", "D:\\Finance\\Annual Report.pdf", { dir: false, extension: "pdf" })).toBe(true);
    expect(matcher.test("Annual Report.pdf", "D:\\Personal\\Annual Report.pdf", { dir: false, extension: "pdf" })).toBe(false);
    expect(compileNameMatcher("name:vacation*.mp4", false).test("Vacation 2024.mp4", "D:\\Media\\Vacation 2024.mp4", { dir: false, extension: "mp4" })).toBe(true);
  });
});
