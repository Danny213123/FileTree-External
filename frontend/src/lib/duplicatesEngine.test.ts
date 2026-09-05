import { describe, expect, it } from "vitest";

import type { DupeCriteria } from "../api/types";
import {
  actionableDuplicatePaths,
  applyProtectedLocations,
  buildContentGroups,
  normalizeForKey,
  type CandidateMeta,
} from "./duplicatesEngine";

const criteria: DupeCriteria = {
  content: { enabled: true, required: true },
  size: { enabled: true, required: false },
  name: { enabled: true, required: false },
  date: { enabled: true, required: false },
  nameFuzzy: false,
  nameThreshold: 80,
  dateToleranceSec: 0,
};

function candidate(path: string, modified: number): CandidateMeta {
  const slash = path.lastIndexOf("\\");
  const name = path.slice(slash + 1);
  return {
    path,
    name,
    folder: path.slice(0, slash),
    size: 1024,
    modifiedMs: modified * 1000,
    mtimeSec: modified,
    ext: "txt",
    hidden: false,
  };
}

function exactGroup() {
  const files = [
    candidate("C:\\Downloads\\notes copy.txt", 300),
    candidate("C:\\Library\\notes.txt", 100),
    candidate("D:\\Backup\\notes.txt", 200),
  ];
  const byPath = new Map(files.map((file) => [normalizeForKey(file.path), file]));
  return buildContentGroups([{ paths: files.map((file) => file.path) }], byPath, criteria, "newest")[0];
}

describe("duplicate protection policy", () => {
  it("makes a protected-location file the keeper and excludes protected copies from actions", () => {
    const [group] = applyProtectedLocations(
      [exactGroup()],
      ["c:\\library"],
      criteria,
      "newest",
      true,
    );

    expect(group.files.find((file) => file.ref)?.path).toBe("C:\\Library\\notes.txt");
    expect(group.files.find((file) => file.path.includes("Library"))?.protected).toBe(true);
    expect(actionableDuplicatePaths([group])).toEqual([
      "C:\\Downloads\\notes copy.txt",
      "D:\\Backup\\notes.txt",
    ]);
    expect(group.waste).toBe(2048);
  });

  it("keeps every file under a protected root out of reclaimable actions", () => {
    const [group] = applyProtectedLocations(
      [exactGroup()],
      ["C:\\", "D:\\"],
      criteria,
      "newest",
      true,
    );

    expect(actionableDuplicatePaths([group])).toEqual([]);
    expect(group.waste).toBe(0);
  });

  it("reapplies the configured keeper rule after protection is removed", () => {
    const [protectedGroup] = applyProtectedLocations(
      [exactGroup()],
      ["C:\\Library"],
      criteria,
      "newest",
      true,
    );
    const [unprotectedGroup] = applyProtectedLocations(
      [protectedGroup],
      [],
      criteria,
      "newest",
      true,
    );

    expect(unprotectedGroup.files.find((file) => file.ref)?.path).toBe("C:\\Downloads\\notes copy.txt");
    expect(unprotectedGroup.files.every((file) => !file.protected)).toBe(true);
  });

  it("preserves an explicit keeper when an unrelated location is protected", () => {
    const original = exactGroup();
    const explicit = {
      ...original,
      files: original.files.map((file) => ({
        ...file,
        ref: file.path.includes("Backup"),
      })),
    };
    const [updated] = applyProtectedLocations(
      [explicit],
      ["E:\\Unrelated"],
      criteria,
      "newest",
      true,
    );

    expect(updated.files.find((file) => file.ref)?.path).toBe("D:\\Backup\\notes.txt");
  });
});
