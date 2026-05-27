export type FilterField = "name" | "path" | "parentFolder" | "anyParentFolder";
export type FilterOperator =
  | "contains" | "notContains"
  | "startsWith" | "notStartsWith"
  | "endsWith" | "notEndsWith"
  | "equals" | "notEquals"
  | "matchesPattern" | "notMatchesPattern"
  | "matchesRegex" | "notMatchesRegex";
export type FilterJoin = "and" | "or";

export interface FilterRule {
  id: string;
  join: FilterJoin;
  field: FilterField;
  operator: FilterOperator;
  value: string;
}

export const FIELD_LABELS: Record<FilterField, string> = {
  name: "Name",
  path: "Path",
  parentFolder: "Parent Folder Name",
  anyParentFolder: "Any Parent Folder Name",
};

export const OPERATOR_LABELS: Record<FilterOperator, string> = {
  contains: "contains",
  notContains: "does not contain",
  startsWith: "starts with",
  notStartsWith: "does not start with",
  endsWith: "ends with",
  notEndsWith: "does not end with",
  equals: "equals",
  notEquals: "does not equal",
  matchesPattern: "matches pattern",
  notMatchesPattern: "does not match pattern",
  matchesRegex: "matches Regular Expression",
  notMatchesRegex: "does not match Regular Expression",
};

export function makeRule(join: FilterJoin = "and"): FilterRule {
  return {
    id: Math.random().toString(36).slice(2),
    join,
    field: "name",
    operator: "contains",
    value: "",
  };
}

/** Returns true if a node passes a single rule. */
function testRule(rule: FilterRule, name: string, path: string): boolean {
  const v = rule.value.toLowerCase();
  if (!v) return true;

  const getSubject = (): string => {
    switch (rule.field) {
      case "path": return path.toLowerCase();
      case "parentFolder": {
        const sep = path.lastIndexOf("\\") !== -1 ? "\\" : "/";
        const parentPath = path.substring(0, path.lastIndexOf(sep));
        const parentSep = Math.max(parentPath.lastIndexOf("\\"), parentPath.lastIndexOf("/"));
        return parentPath.substring(parentSep + 1).toLowerCase();
      }
      case "anyParentFolder": return path.toLowerCase();
      default: return name.toLowerCase();
    }
  };

  const subject = getSubject();

  const matches = (): boolean => {
    switch (rule.operator) {
      case "contains":
      case "notContains":
        return subject.includes(v);
      case "startsWith":
      case "notStartsWith":
        return subject.startsWith(v);
      case "endsWith":
      case "notEndsWith":
        return subject.endsWith(v);
      case "equals":
      case "notEquals":
        return subject === v;
      case "matchesPattern":
      case "notMatchesPattern":
        return wildcardMatch(v, subject);
      case "matchesRegex":
      case "notMatchesRegex":
        try { return new RegExp(rule.value, "i").test(subject); }
        catch { return false; }
      default:
        return false;
    }
  };

  const result = matches();
  const isNegated = rule.operator.startsWith("not") || rule.operator.startsWith("doesNot");
  return isNegated ? !result : result;
}

function wildcardMatch(pattern: string, value: string): boolean {
  // Simple glob: * matches any, ? matches one
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  try { return new RegExp(`^${regex}$`, "i").test(value); }
  catch { return false; }
}

/** Returns true if a node passes all active rules (with And/Or logic). */
export function applyRules(rules: FilterRule[], name: string, path: string): boolean {
  const active = rules.filter((r) => r.value.trim() !== "");
  if (active.length === 0) return true;

  // First rule always applies as-is; subsequent rules use their join.
  let result = testRule(active[0], name, path);
  for (let i = 1; i < active.length; i++) {
    const r = active[i];
    if (r.join === "or") {
      result = result || testRule(r, name, path);
    } else {
      result = result && testRule(r, name, path);
    }
  }
  return result;
}
