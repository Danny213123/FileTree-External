import { describe, expect, it } from "vitest";

import type { DupeCriteria } from "../api/types";
import {
  actionableDuplicatePaths,
  applyProtectedLocations,
  buildContentGroups,
  buildKeyedGroups,
  minimalScanTargets,
  normalizeForKey,
  scopeStateForPath,
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

  it("uses the nearest folder rule so a child can override its parent", () => {
    const rules = [
      { path: "C:\\", state: "normal" as const },
      { path: "C:\\Library", state: "reference" as const },
      { path: "C:\\Library\\Scratch", state: "normal" as const },
      { path: "C:\\Library\\Scratch\\Generated", state: "excluded" as const },
    ];

    expect(scopeStateForPath("C:\\Library\\master.bin", rules)).toBe("reference");
    expect(scopeStateForPath("C:\\Library\\Scratch\\draft.bin", rules)).toBe("normal");
    expect(scopeStateForPath("C:\\Library\\Scratch\\Generated\\tmp.bin", rules)).toBe("excluded");
  });

  it("stages overlapping selected folders through their shallowest scan root once", () => {
    expect(minimalScanTargets([
      "C:\\",
      "C:\\Library",
      "c:\\library\\Photos",
      "D:\\Archive",
      "D:\\Archive",
    ])).toEqual(["C:\\", "D:\\Archive"]);
  });
});

describe("metadata matching", () => {
  it("ignores disabled required flags and does not mark contents verified", () => {
    const files = [candidate("C:\\one.txt", 100), candidate("D:\\two.txt", 200)];
    const result = buildKeyedGroups(files, {
      ...criteria,
      content: { enabled: false, required: true },
      name: { enabled: false, required: true },
      date: { enabled: false, required: true },
      size: { enabled: true, required: true },
    }, "newest");
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].files.every((file) => file.match?.content === 0)).toBe(true);
  });
});
