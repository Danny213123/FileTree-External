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

// ── ReDoS hardening for user-supplied patterns ───────────────────────────────
// Filter rules accept raw regular expressions ("matches Regular Expression") and
// globs. JavaScript's regex engine backtracks and has no timeout, so a
// pathological pattern can freeze the UI thread (catastrophic backtracking). We
// bound the pattern + subject length, reject patterns with nested unbounded
// quantifiers (the classic blow-up, e.g. `(a+)+`), cache compiled patterns, and
// never throw — a rejected/invalid pattern simply matches nothing.
const MAX_PATTERN_LEN = 1000;
const MAX_SUBJECT_LEN = 4096;
const regexCache = new Map<string, RegExp | null>();

/** Detect nested unbounded quantifiers (regex "star height" > 1) — e.g. `(a+)+`,
 *  `(a*)*`, `((ab)*)+` — the usual source of exponential backtracking. */
function hasNestedQuantifier(source: string): boolean {
  const isQuant = (ch: string | undefined): boolean => ch === "*" || ch === "+";
  const groupHasQuantifier: boolean[] = [];
  let escaped = false;
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (escaped) { escaped = false; continue; }
    if (c === "\\") { escaped = true; continue; }
    if (inClass) { if (c === "]") inClass = false; continue; }
    if (c === "[") { inClass = true; continue; }
    if (c === "(") { groupHasQuantifier.push(false); continue; }
    if (c === ")") {
      const bodyQuantified = groupHasQuantifier.pop() ?? false;
      const next = source[i + 1];
      if (bodyQuantified && isQuant(next)) return true;
      // Quantifying this whole group counts toward its parent group's body.
      if (isQuant(next) && groupHasQuantifier.length) {
        groupHasQuantifier[groupHasQuantifier.length - 1] = true;
      }
      continue;
    }
    if (isQuant(c) && groupHasQuantifier.length) {
      groupHasQuantifier[groupHasQuantifier.length - 1] = true;
    }
  }
  return false;
}

/** Compile a user pattern defensively. Returns null (never throws) when the
 *  pattern is too long, structurally dangerous, or syntactically invalid. */
function compileSafeRegex(source: string, flags: string): RegExp | null {
  if (!source || source.length > MAX_PATTERN_LEN) return null;
  const cacheKey = `${flags}\u0000${source}`;
  const cached = regexCache.get(cacheKey);
  if (cached !== undefined) return cached;
  let compiled: RegExp | null = null;
  if (!hasNestedQuantifier(source)) {
    try { compiled = new RegExp(source, flags); } catch { compiled = null; }
  }
  if (regexCache.size > 256) regexCache.clear();
  regexCache.set(cacheKey, compiled);
  return compiled;
}

/** Cap subject length so even a near-pathological pattern can't run against an
 *  unexpectedly huge string. */
function boundSubject(value: string): string {
  return value.length > MAX_SUBJECT_LEN ? value.slice(0, MAX_SUBJECT_LEN) : value;
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

// Text predicate over a PRE-COMPILED rule: the (cached, ReDoS-guarded) RegExp
// for regex/glob operators is built once per rule by compileRules() and reused
// here for every node — no per-node compilation or even cache lookup. Non-regex
// operators (contains/startsWith/…) are plain string ops.
function testTextCompiled(cr: CompiledRule, name: string, path: string, owner: string): boolean {
  const { rule, regex } = cr;
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
      case "matchesRegex":
      case "notMatchesRegex":
        // `regex` was produced via compileSafeRegex (length/star-height guards,
        // never throws). A null result = invalid/dangerous pattern → matches
        // nothing. Subject is still length-capped per match.
        return regex ? regex.test(boundSubject(subject)) : false;
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

/** Returns true if a node passes a single PRE-COMPILED rule. */
function testRuleCompiled(cr: CompiledRule, node: FilterableNode): boolean {
  switch (fieldKind(cr.rule.field)) {
    case "size": return testSize(cr.rule, node.size);
    case "date": return testDate(cr.rule, node.modified);
    case "type": return testType(cr.rule, node.extension);
    default: return testTextCompiled(cr, node.name, node.path, node.owner ?? "");
  }
}

/** Translate a simple glob (`*` = any, `?` = one) into an anchored regex source.
 *  Collapse runs of '*' first (glob `**` ≡ `*`) so the compiled regex never
 *  contains adjacent ".*.*", a catastrophic-backtracking trap, then escape
 *  metacharacters and translate. Returned to compileSafeRegex which applies the
 *  length / star-height guards. */
function globToRegexSource(pattern: string): string {
  const body = pattern
    .replace(/\*+/g, "*")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return `^${body}$`;
}

// ── Precompiled rules ─────────────────────────────────────────────────────────
// A rule's RegExp (regex / glob operators) is compiled ONCE — here — instead of
// once per visible node. compileRules() runs only when the rule set changes (it's
// memoized by the caller), so the per-row match path reuses one cached, ReDoS-
// guarded RegExp. compileSafeRegex still enforces the pattern-length and
// nested-quantifier (star-height) limits and never throws.

/** A filter rule paired with its precompiled RegExp (for regex/glob operators).
 *  `regex` is null when the pattern is empty, too long, structurally dangerous,
 *  or syntactically invalid, and undefined for non-regex operators. */
export interface CompiledRule {
  rule: FilterRule;
  regex?: RegExp | null;
}

/** Precompile a rule set: keep only the active rules and compile each regex/glob
 *  operator's RegExp once (via the guarded, cached compileSafeRegex). Memoize the
 *  result (see useTreeState) so it is built per rule-set change, not per row. */
export function compileRules(rules: FilterRule[]): CompiledRule[] {
  return rules.filter(isActiveRule).map((rule): CompiledRule => {
    switch (rule.operator) {
      case "matchesRegex":
      case "notMatchesRegex":
        return { rule, regex: compileSafeRegex(rule.value, "i") };
      case "matchesPattern":
      case "notMatchesPattern":
        return { rule, regex: compileSafeRegex(globToRegexSource(rule.value.toLowerCase()), "i") };
      default:
        return { rule };
    }
  });
}

/** Returns true if a node passes all precompiled rules (with And/Or logic).
 *  The hot path: called once per node with already-compiled RegExps. */
export function applyCompiledRules(compiled: CompiledRule[], node: FilterableNode): boolean {
  if (compiled.length === 0) return true;

  // First rule always applies as-is; subsequent rules use their join.
  let result = testRuleCompiled(compiled[0], node);
  for (let i = 1; i < compiled.length; i++) {
    const c = compiled[i];
    if (c.rule.join === "or") {
      result = result || testRuleCompiled(c, node);
    } else {
      result = result && testRuleCompiled(c, node);
    }
  }
  return result;
}

/** Convenience wrapper that compiles + applies in one call. NOT for hot paths
 *  (it recompiles each call); virtualized lists should memoize compileRules()
 *  and call applyCompiledRules() per row instead. */
export function applyRules(rules: FilterRule[], node: FilterableNode): boolean {
  return applyCompiledRules(compileRules(rules), node);
}
