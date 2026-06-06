const { test, describe } = require("node:test");
const assert = require("node:assert");
const {
  normalizeSpdx,
  parseExpression,
  parseList,
  isUnrecognized,
  evaluate,
  splitNameVersion,
  recordsFromLicenseChecker,
  recordsFromPipLicenses,
  audit,
} = require("../src/audit");

describe("normalizeSpdx", () => {
  test("uppercases and trims", () => {
    assert.strictEqual(normalizeSpdx("  mit "), "MIT");
    assert.strictEqual(normalizeSpdx("Apache-2.0"), "APACHE-2.0");
  });
  test("handles null/undefined", () => {
    assert.strictEqual(normalizeSpdx(null), "");
    assert.strictEqual(normalizeSpdx(undefined), "");
  });
});

describe("parseExpression", () => {
  test("single license", () => {
    assert.deepStrictEqual(parseExpression("MIT"), {
      operator: "SINGLE",
      terms: ["MIT"],
    });
  });

  test("OR expression with parentheses", () => {
    const r = parseExpression("(MIT OR Apache-2.0)");
    assert.strictEqual(r.operator, "OR");
    assert.deepStrictEqual(r.terms, ["MIT", "Apache-2.0"]);
  });

  test("AND expression", () => {
    const r = parseExpression("MIT AND ISC");
    assert.strictEqual(r.operator, "AND");
    assert.deepStrictEqual(r.terms, ["MIT", "ISC"]);
  });

  test("OR is case insensitive", () => {
    const r = parseExpression("MIT or Apache-2.0");
    assert.strictEqual(r.operator, "OR");
  });

  test("WITH exception clause is reduced to the base license", () => {
    const r = parseExpression("GPL-2.0 WITH Classpath-exception-2.0");
    assert.strictEqual(r.operator, "SINGLE");
    assert.deepStrictEqual(r.terms, ["GPL-2.0"]);
  });

  test("substring 'or'/'and' inside an id is not a delimiter", () => {
    const r = parseExpression("CC-BY-NC-ND-4.0");
    assert.strictEqual(r.operator, "SINGLE");
    assert.deepStrictEqual(r.terms, ["CC-BY-NC-ND-4.0"]);
  });
});

describe("parseList", () => {
  test("comma separated", () => {
    const s = parseList("MIT,Apache-2.0,ISC");
    assert.ok(s.has("MIT") && s.has("APACHE-2.0") && s.has("ISC"));
    assert.strictEqual(s.size, 3);
  });
  test("whitespace separated", () => {
    const s = parseList("MIT  Apache-2.0\nISC");
    assert.strictEqual(s.size, 3);
  });
  test("mixed comma and whitespace", () => {
    const s = parseList("MIT, Apache-2.0 ,  ISC");
    assert.strictEqual(s.size, 3);
  });
  test("empty input yields empty set", () => {
    assert.strictEqual(parseList("").size, 0);
    assert.strictEqual(parseList(undefined).size, 0);
  });
  test("normalizes case", () => {
    assert.ok(parseList("mit").has("MIT"));
  });
});

describe("isUnrecognized", () => {
  test("UNKNOWN is unrecognized", () => {
    assert.ok(isUnrecognized("UNKNOWN"));
    assert.ok(isUnrecognized("unknown"));
  });
  test("free text is unrecognized", () => {
    assert.ok(isUnrecognized("Custom: see LICENSE"));
    assert.ok(isUnrecognized("Some Proprietary License"));
  });
  test("known ids are recognized", () => {
    assert.ok(!isUnrecognized("MIT"));
    assert.ok(!isUnrecognized("Apache-2.0"));
  });
});

describe("evaluate - allowlist mode", () => {
  const allow = parseList("MIT, Apache-2.0");
  const deny = parseList("");

  test("allowed single license passes", () => {
    assert.strictEqual(evaluate("MIT", allow, deny).violation, false);
  });
  test("case-insensitive match passes", () => {
    assert.strictEqual(evaluate("mit", allow, deny).violation, false);
  });
  test("not-allowed single license violates", () => {
    const r = evaluate("GPL-3.0", allow, deny);
    assert.strictEqual(r.violation, true);
    assert.strictEqual(r.reason, "not in allowlist");
  });
  test("OR: allowed if any option is allowed", () => {
    assert.strictEqual(evaluate("(GPL-3.0 OR MIT)", allow, deny).violation, false);
  });
  test("OR: violates if no option is allowed", () => {
    assert.strictEqual(evaluate("(GPL-3.0 OR LGPL-3.0)", allow, deny).violation, true);
  });
  test("AND: all components must be allowed", () => {
    assert.strictEqual(evaluate("MIT AND Apache-2.0", allow, deny).violation, false);
    assert.strictEqual(evaluate("MIT AND GPL-3.0", allow, deny).violation, true);
  });
  test("unrecognized license violates in allowlist mode", () => {
    const r = evaluate("UNKNOWN", allow, deny);
    assert.strictEqual(r.violation, true);
    assert.strictEqual(r.reason, "unrecognized license");
  });
});

describe("evaluate - denylist mode", () => {
  const allow = parseList("");
  const deny = parseList("GPL-3.0, AGPL-3.0");

  test("non-denied license passes", () => {
    assert.strictEqual(evaluate("MIT", allow, deny).violation, false);
  });
  test("denied single license violates", () => {
    const r = evaluate("GPL-3.0", allow, deny);
    assert.strictEqual(r.violation, true);
    assert.strictEqual(r.reason, "on denylist");
  });
  test("OR: violates only when ALL options are denied", () => {
    // one non-denied option present -> consumer can pick it -> no violation
    assert.strictEqual(evaluate("(GPL-3.0 OR MIT)", allow, deny).violation, false);
    // all options denied -> violation
    assert.strictEqual(evaluate("(GPL-3.0 OR AGPL-3.0)", allow, deny).violation, true);
  });
  test("AND: violates if any component is denied", () => {
    assert.strictEqual(evaluate("MIT AND GPL-3.0", allow, deny).violation, true);
    assert.strictEqual(evaluate("MIT AND ISC", allow, deny).violation, false);
  });
  test("unrecognized license is a warning, not a violation", () => {
    const r = evaluate("UNKNOWN", allow, deny);
    assert.strictEqual(r.violation, false);
    assert.strictEqual(r.warning, "unrecognized license");
  });
});

describe("evaluate - allowlist precedence over denylist", () => {
  test("allow takes precedence when both provided", () => {
    const allow = parseList("MIT");
    const deny = parseList("MIT");
    // In allowlist mode MIT is allowed, so no violation even though it is also
    // on the deny list (allow wins).
    assert.strictEqual(evaluate("MIT", allow, deny).violation, false);
    // A license not in allow violates even if also not in deny.
    assert.strictEqual(evaluate("ISC", allow, deny).violation, true);
  });
});

describe("splitNameVersion", () => {
  test("plain package", () => {
    assert.deepStrictEqual(splitNameVersion("lodash@4.17.21"), {
      name: "lodash",
      version: "4.17.21",
    });
  });
  test("scoped package", () => {
    assert.deepStrictEqual(splitNameVersion("@babel/core@7.0.0"), {
      name: "@babel/core",
      version: "7.0.0",
    });
  });
});

describe("recordsFromLicenseChecker", () => {
  test("flattens and joins array licenses with AND", () => {
    const recs = recordsFromLicenseChecker({
      "lodash@4.17.21": { licenses: "MIT" },
      "dual@1.0.0": { licenses: ["MIT", "ISC"] },
    });
    const lodash = recs.find((r) => r.package === "lodash");
    const dual = recs.find((r) => r.package === "dual");
    assert.strictEqual(lodash.license, "MIT");
    assert.strictEqual(lodash.version, "4.17.21");
    assert.strictEqual(dual.license, "MIT AND ISC");
  });
  test("missing license becomes UNKNOWN", () => {
    const recs = recordsFromLicenseChecker({ "x@1.0.0": {} });
    assert.strictEqual(recs[0].license, "UNKNOWN");
  });
});

describe("recordsFromPipLicenses", () => {
  test("maps pip-licenses fields", () => {
    const recs = recordsFromPipLicenses([
      { Name: "requests", Version: "2.31.0", License: "Apache-2.0" },
    ]);
    assert.deepStrictEqual(recs[0], {
      package: "requests",
      version: "2.31.0",
      license: "Apache-2.0",
    });
  });
});

describe("audit", () => {
  const records = [
    { package: "a", version: "1.0.0", license: "MIT" },
    { package: "b", version: "2.0.0", license: "GPL-3.0" },
    { package: "c", version: "3.0.0", license: "UNKNOWN" },
  ];

  test("allowlist mode collects violations and unrecognized", () => {
    const { violations } = audit(records, parseList("MIT"), parseList(""));
    const names = violations.map((v) => v.package).sort();
    assert.deepStrictEqual(names, ["b", "c"]);
  });

  test("denylist mode flags denied, warns on unrecognized", () => {
    const { violations, warnings } = audit(records, parseList(""), parseList("GPL-3.0"));
    assert.deepStrictEqual(violations.map((v) => v.package), ["b"]);
    assert.deepStrictEqual(warnings.map((w) => w.package), ["c"]);
  });
});
