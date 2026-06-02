export type FilterField =
  | "name" | "path" | "parentFolder" | "anyParentFolder"
  | "size" | "date" | "type" | "owner";

export type FilterOperator =
  // text fields
  | "contains" | "notContains"
  | "startsWith" | "notStartsWith"
  | "endsWith" | "notEndsWith"
  | "equals" | "notEquals"
  | "matchesPattern" | "notMatchesPattern"
  | "matchesRegex" | "notMatchesRegex"
  // size (numeric, with unit)
  | "greaterThan" | "lessThan" | "between"
  // date modified
  | "before" | "after"
  // extension / type
  | "isOneOf" | "isNotOneOf";

export type FilterJoin = "and" | "or";

/** Unit selector for size predicates. */
export type SizeUnit = "bytes" | "kb" | "mb" | "gb" | "tb";

/** Editor kind for a field — drives which operators + value inputs show. */
export type FilterFieldKind = "text" | "size" | "date" | "type";

export interface FilterRule {
  id: string;
  join: FilterJoin;
  field: FilterField;
  operator: FilterOperator;
  /** Primary value. A rule is "active" iff this is non-empty (all field kinds). */
  value: string;
  /** Upper bound for "between" (size / date). Optional → one-sided when absent. */
  value2?: string;
  /** Size field only: the unit `value`/`value2` are expressed in. */
  sizeUnit?: SizeUnit;
}

/** Minimal node shape the rule engine needs (NodeRecord is compatible). */
export interface FilterableNode {
  name: string;
  path: string;
  size: number;
  /** Epoch milliseconds (NodeRecord.modified). */
  modified: number;
  /** Lowercase extension, no leading dot (NodeRecord.extension). */
  extension: string;
  /** Owner account ("DOMAIN\\user"); "" / undefined when not collected. */
  owner?: string;
}

export const FIELD_LABELS: Record<FilterField, string> = {
  name: "Name",
  path: "Path",
  parentFolder: "Parent Folder Name",
  anyParentFolder: "Any Parent Folder Name",
  size: "Size",
  date: "Date Modified",
  type: "Type / Extension",
  owner: "Owner",
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
  greaterThan: "greater than",
  lessThan: "less than",
  between: "between",
  before: "before",
  after: "on or after",
  isOneOf: "is one of",
  isNotOneOf: "is not one of",
};

export const SIZE_UNIT_LABELS: Record<SizeUnit, string> = {
  bytes: "bytes",
  kb: "KB",
  mb: "MB",
  gb: "GB",
  tb: "TB",
};

const SIZE_UNIT_FACTORS: Record<SizeUnit, number> = {
  bytes: 1,
  kb: 1024,
  mb: 1024 * 1024,
  gb: 1024 * 1024 * 1024,
  tb: 1024 * 1024 * 1024 * 1024,
};

const TEXT_OPERATORS: FilterOperator[] = [
  "startsWith", "contains", "endsWith", "equals",
  "matchesPattern", "matchesRegex",
  "notEquals", "notStartsWith", "notContains", "notEndsWith",
  "notMatchesPattern", "notMatchesRegex",
];
const SIZE_OPERATORS: FilterOperator[] = ["greaterThan", "lessThan", "between"];
const DATE_OPERATORS: FilterOperator[] = ["after", "before", "between"];
const TYPE_OPERATORS: FilterOperator[] = ["isOneOf", "isNotOneOf"];

export function fieldKind(field: FilterField): FilterFieldKind {
  switch (field) {
    case "size": return "size";
    case "date": return "date";
    case "type": return "type";
    default: return "text";
  }
}

/** Operators valid for a field, in display order (first = default). */
export function operatorsForField(field: FilterField): FilterOperator[] {
  switch (fieldKind(field)) {
    case "size": return SIZE_OPERATORS;
    case "date": return DATE_OPERATORS;
    case "type": return TYPE_OPERATORS;
    default: return TEXT_OPERATORS;
  }
}

export function makeRule(join: FilterJoin = "and"): FilterRule {
  return {
    id: Math.random().toString(36).slice(2),
    join,
    field: "name",
    operator: "contains",
    value: "",
  };
}

/** Re-base a rule onto a new field: pick that field's default operator and
 *  clear the value(s) (a number/date left over from the old field would be
 *  meaningless under the new one). Used by the dialog's field dropdown. */
export function ruleForField(rule: FilterRule, field: FilterField): FilterRule {
  const kind = fieldKind(field);
  return {
    ...rule,
    field,
    operator: operatorsForField(field)[0],
    value: "",
    value2: undefined,
    sizeUnit: kind === "size" ? (rule.sizeUnit ?? "mb") : undefined,
  };
}

/** A rule participates in filtering only when its primary value is non-empty. */
export function isActiveRule(rule: FilterRule): boolean {
  return rule.value.trim() !== "";
}

// ── Predicates per field kind ────────────────────────────────────────────────

function textSubject(field: FilterField, name: string, path: string, owner: string): string {
  switch (field) {
    case "path": return path.toLowerCase();
    case "owner": return owner.toLowerCase();
    case "parentFolder": {
      const sep = path.lastIndexOf("\\") !== -1 ? "\\" : "/";
      const parentPath = path.substring(0, path.lastIndexOf(sep));
      const parentSep = Math.max(parentPath.lastIndexOf("\\"), parentPath.lastIndexOf("/"));
      return parentPath.substring(parentSep + 1).toLowerCase();
    }
    case "anyParentFolder": return path.toLowerCase();
    default: return name.toLowerCase();
  }
}

function testText(rule: FilterRule, name: string, path: string, owner: string): boolean {
  const v = rule.value.toLowerCase();
  if (!v) return true;
  const subject = textSubject(rule.field, name, path, owner);

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
  const isNegated = rule.operator.startsWith("not");
  return isNegated ? !result : result;
}

function parseSizeBytes(value: string, unit: SizeUnit | undefined): number | null {
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return null;
  return n * SIZE_UNIT_FACTORS[unit ?? "bytes"];
}

function testSize(rule: FilterRule, size: number): boolean {
  const a = parseSizeBytes(rule.value, rule.sizeUnit);
  if (a === null) return true; // incomplete rule → don't exclude anything
  switch (rule.operator) {
    case "greaterThan": return size > a;
    case "lessThan": return size < a;
    case "between": {
      const b = parseSizeBytes(rule.value2 ?? "", rule.sizeUnit);
      if (b === null) return size >= a; // one-sided lower bound
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      return size >= lo && size <= hi;
    }
    default: return true;
  }
}

function parseDateMs(value: string): number | null {
  if (!value.trim()) return null;
  const ms = Date.parse(value); // "YYYY-MM-DD" → UTC midnight
  return Number.isNaN(ms) ? null : ms;
}

const ONE_DAY_MS = 86_400_000;

function testDate(rule: FilterRule, modifiedMs: number): boolean {
  const a = parseDateMs(rule.value);
  if (a === null) return true;
  switch (rule.operator) {
    case "after": return modifiedMs >= a;
    case "before": return modifiedMs < a;
    case "between": {
      const b = parseDateMs(rule.value2 ?? "");
      if (b === null) return modifiedMs >= a; // one-sided lower bound
      const lo = Math.min(a, b);
      // Include the whole end day (date inputs are day-granular).
      const hi = Math.max(a, b) + ONE_DAY_MS;
      return modifiedMs >= lo && modifiedMs < hi;
    }
    default: return true;
  }
}

function parseExtList(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[\s,;]+/)
    .map((s) => s.replace(/^\.+/, "").trim())
    .filter(Boolean);
}

function testType(rule: FilterRule, extension: string): boolean {
  const exts = parseExtList(rule.value);
  if (exts.length === 0) return true;
  const ext = extension.toLowerCase().replace(/^\.+/, "");
  const isMatch = exts.includes(ext);
  return rule.operator === "isNotOneOf" ? !isMatch : isMatch;
}

/** Returns true if a node passes a single rule. */
function testRule(rule: FilterRule, node: FilterableNode): boolean {
  switch (fieldKind(rule.field)) {
    case "size": return testSize(rule, node.size);
    case "date": return testDate(rule, node.modified);
    case "type": return testType(rule, node.extension);
    default: return testText(rule, node.name, node.path, node.owner ?? "");
  }
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
export function applyRules(rules: FilterRule[], node: FilterableNode): boolean {
  const active = rules.filter(isActiveRule);
  if (active.length === 0) return true;

  // First rule always applies as-is; subsequent rules use their join.
  let result = testRule(active[0], node);
  for (let i = 1; i < active.length; i++) {
    const r = active[i];
    if (r.join === "or") {
      result = result || testRule(r, node);
    } else {
      result = result && testRule(r, node);
    }
  }
  return result;
}
