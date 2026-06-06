"use strict";

const fs = require("node:fs");

// Tokens that delimit SPDX license expressions. We split on these (case
// insensitive, whitespace-bounded) and also strip WITH exception clauses.
const OR_TOKEN = /\s+OR\s+/i;
const AND_TOKEN = /\s+AND\s+/i;

// A license string we cannot map to a known SPDX id. license-checker emits
// "UNKNOWN" for these; pip-licenses emits "UNKNOWN" or free-text like
// "Custom License". We treat anything we cannot confidently parse as a single
// unrecognized component.
function isUnrecognized(id) {
  if (!id) return true;
  const u = id.trim().toUpperCase();
  if (u === "UNKNOWN" || u === "UNLICENSED" || u === "") return true;
  // Free-text descriptions (contain a colon or spaces that are not OR/AND
  // operators) are unrecognized. After parseExpression splits operators, a
  // remaining internal space means free text like "Custom: foo".
  if (u.includes(":")) return true;
  if (/\s/.test(u)) return true;
  return false;
}

// Normalize an SPDX id for case-insensitive comparison. Strips surrounding
// whitespace and uppercases. Comparison everywhere uses this form.
function normalizeSpdx(id) {
  if (id === null || id === undefined) return "";
  return String(id).trim().toUpperCase();
}

// Parse an SPDX license expression into { operator, terms }. Parentheses are
// stripped. Operator is "OR", "AND", or "SINGLE". "WITH" exception clauses are
// reduced to the base license (e.g. "GPL-2.0 WITH Classpath-exception" -> the
// term "GPL-2.0"). Mixed OR/AND is rare in dependency metadata; we detect the
// top-level operator by presence, preferring OR (the consumer-favorable case).
function parseExpression(expr) {
  if (expr === null || expr === undefined) {
    return { operator: "SINGLE", terms: [""] };
  }
  let s = String(expr).trim();
  // Strip all parentheses. Dependency-metadata expressions are flat enough that
  // we do not need a real precedence parser; the spec calls for stripping
  // parens and splitting on OR/AND tokens.
  s = s.replace(/[()]/g, " ").trim();

  const stripWith = (term) => term.split(/\s+WITH\s+/i)[0].trim();

  let operator = "SINGLE";
  let parts;
  if (OR_TOKEN.test(s)) {
    operator = "OR";
    parts = s.split(OR_TOKEN);
  } else if (AND_TOKEN.test(s)) {
    operator = "AND";
    parts = s.split(AND_TOKEN);
  } else {
    parts = [s];
  }

  const terms = parts.map((p) => stripWith(p)).filter((p) => p.length > 0);
  if (terms.length === 0) terms.push("");
  if (terms.length === 1) operator = "SINGLE";
  return { operator, terms };
}

// Parse a comma- and/or whitespace-separated list of SPDX ids into a Set of
// normalized ids. Empty input yields an empty set.
function parseList(raw) {
  const set = new Set();
  if (!raw) return set;
  String(raw)
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .forEach((t) => set.add(normalizeSpdx(t)));
  return set;
}

// Evaluate one package's license expression against allow/deny sets.
// Returns { violation: bool, reason: string } where reason is "" when no
// violation. allowSet takes precedence: if non-empty, denySet is ignored.
//
// Semantics (per spec):
//  - allowlist mode (allowSet non-empty):
//      OR  -> allowed if ANY term is allowed; violation otherwise.
//      AND -> allowed only if ALL terms are allowed.
//      SINGLE -> allowed if the term is allowed.
//      unrecognized term -> counts as not-allowed (reason "unrecognized
//      license" when the package is unrecognized overall).
//  - denylist mode (denySet non-empty, allowSet empty):
//      OR  -> violation only if ALL terms are denied (consumer can pick a
//             non-denied option).
//      AND / SINGLE -> violation if ANY term is denied.
//      unrecognized -> not a violation; surfaced as a warning by the caller.
function evaluate(licenseExpr, allowSet, denySet) {
  const { operator, terms } = parseExpression(licenseExpr);
  const normTerms = terms.map(normalizeSpdx);
  const allUnrecognized = terms.every((t) => isUnrecognized(t));

  if (allowSet && allowSet.size > 0) {
    if (allUnrecognized) {
      return { violation: true, reason: "unrecognized license" };
    }
    const isAllowed = (t) => allowSet.has(t);
    let allowed;
    if (operator === "OR") {
      // A term that is unrecognized cannot be in the allowlist, so it simply
      // does not contribute an allowed option.
      allowed = normTerms.some(isAllowed);
    } else {
      // AND and SINGLE: every component must be allowed.
      allowed = normTerms.every(isAllowed);
    }
    if (allowed) return { violation: false, reason: "" };
    return { violation: true, reason: "not in allowlist" };
  }

  if (denySet && denySet.size > 0) {
    if (allUnrecognized) {
      // Denylist mode: unrecognized is a warning, not a violation.
      return { violation: false, reason: "", warning: "unrecognized license" };
    }
    const isDenied = (t) => denySet.has(t);
    let denied;
    if (operator === "OR") {
      // Violation only if every option is denied.
      denied = normTerms.every(isDenied);
    } else {
      denied = normTerms.some(isDenied);
    }
    if (denied) return { violation: true, reason: "on denylist" };
    return { violation: false, reason: "" };
  }

  // Neither provided: caller should have validated. Treat as no violation.
  return { violation: false, reason: "" };
}

// Split a "name@version" key (as emitted by license-checker) into parts.
function splitNameVersion(key) {
  // Scoped packages look like "@scope/name@1.2.3"; the version is after the
  // LAST "@".
  const at = key.lastIndexOf("@");
  if (at <= 0) return { name: key, version: "" };
  return { name: key.slice(0, at), version: key.slice(at + 1) };
}

// Normalize a license-checker JSON object into a flat list of
// { package, version, license } records.
function recordsFromLicenseChecker(obj) {
  const records = [];
  for (const [key, meta] of Object.entries(obj || {})) {
    const { name, version } = splitNameVersion(key);
    let license = meta && meta.licenses;
    if (Array.isArray(license)) license = license.join(" AND ");
    records.push({
      package: name,
      version: version || (meta && meta.version) || "",
      license: license == null ? "UNKNOWN" : String(license),
    });
  }
  return records;
}

// Normalize a pip-licenses JSON array into the same flat record shape.
function recordsFromPipLicenses(arr) {
  const records = [];
  for (const item of arr || []) {
    records.push({
      package: item.Name || item.name || "",
      version: item.Version || item.version || "",
      license: item.License || item.license || "UNKNOWN",
    });
  }
  return records;
}

// Read and parse a scanner JSON file, returning flat records. `kind` is
// "npm" or "python".
function readScannerFile(path, kind) {
  const raw = fs.readFileSync(path, "utf8");
  const data = JSON.parse(raw);
  if (kind === "python") return recordsFromPipLicenses(data);
  return recordsFromLicenseChecker(data);
}

// Audit a flat record list. Returns { violations, warnings } where violations
// is an array of { package, version, license, reason }.
function audit(records, allowSet, denySet) {
  const violations = [];
  const warnings = [];
  for (const rec of records) {
    const result = evaluate(rec.license, allowSet, denySet);
    if (result.violation) {
      violations.push({
        package: rec.package,
        version: rec.version,
        license: rec.license,
        reason: result.reason,
      });
    } else if (result.warning) {
      warnings.push({
        package: rec.package,
        version: rec.version,
        license: rec.license,
        reason: result.warning,
      });
    }
  }
  return { violations, warnings };
}

// Append a key=value (or multiline heredoc) line to the $GITHUB_OUTPUT file.
function writeOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) {
    // Local/dev fallback: print so the value is observable.
    process.stdout.write(`${name}=${value}\n`);
    return;
  }
  if (value.includes("\n")) {
    const delim = `__LICENSE_AUDITOR_EOF_${name}__`;
    fs.appendFileSync(file, `${name}<<${delim}\n${value}\n${delim}\n`);
  } else {
    fs.appendFileSync(file, `${name}=${value}\n`);
  }
}

// Main entrypoint when run as a script. Reads config from env vars set by the
// composite step:
//   LICENSE_AUDITOR_ALLOW, LICENSE_AUDITOR_DENY  - raw input strings
//   LICENSE_AUDITOR_NPM_JSON   - path to license-checker JSON (optional)
//   LICENSE_AUDITOR_PYTHON_JSON - path to pip-licenses JSON (optional)
//   LICENSE_AUDITOR_FAIL_ON_VIOLATION - "true"/"false"
function main() {
  const allowRaw = process.env.LICENSE_AUDITOR_ALLOW || "";
  const denyRaw = process.env.LICENSE_AUDITOR_DENY || "";
  const allowSet = parseList(allowRaw);
  const denySet = parseList(denyRaw);

  if (allowSet.size === 0 && denySet.size === 0) {
    console.error(
      'Input "allow"/"deny" must include at least one SPDX id: provide allow, deny, or both.'
    );
    process.exit(1);
  }

  const records = [];
  const npmJson = process.env.LICENSE_AUDITOR_NPM_JSON;
  const pyJson = process.env.LICENSE_AUDITOR_PYTHON_JSON;
  if (npmJson && fs.existsSync(npmJson)) {
    records.push(...readScannerFile(npmJson, "npm"));
  }
  if (pyJson && fs.existsSync(pyJson)) {
    records.push(...readScannerFile(pyJson, "python"));
  }

  const { violations, warnings } = audit(records, allowSet, denySet);

  for (const w of warnings) {
    console.log(
      `::warning::license-auditor: ${w.package}@${w.version} has ${w.reason} (${w.license})`
    );
  }

  const violationsJson = JSON.stringify(violations);
  writeOutput("violations", violationsJson);
  writeOutput("violation-count", String(violations.length));

  // Human summary line.
  const mode = allowSet.size > 0 ? "allowlist" : "denylist";
  if (violations.length === 0) {
    console.log(
      `license-auditor: scanned ${records.length} package(s) in ${mode} mode - no violations.`
    );
  } else {
    console.log(
      `license-auditor: scanned ${records.length} package(s) in ${mode} mode - ${violations.length} violation(s):`
    );
    for (const v of violations) {
      console.log(`  - ${v.package}@${v.version}: ${v.license} (${v.reason})`);
    }
  }

  const failOn = (process.env.LICENSE_AUDITOR_FAIL_ON_VIOLATION || "true").toLowerCase();
  if (failOn === "true" && violations.length > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  normalizeSpdx,
  parseExpression,
  parseList,
  isUnrecognized,
  evaluate,
  splitNameVersion,
  recordsFromLicenseChecker,
  recordsFromPipLicenses,
  audit,
};
