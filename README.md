<div align="center">

# ⚖️ license-auditor

**Fail the build when a dependency carries a license you can't ship — without a heavyweight SaaS scanner.**

<br>

[![Marketplace](https://img.shields.io/badge/Marketplace-license--auditor-2088FF?logo=githubactions&logoColor=white)](https://github.com/marketplace/actions/license-auditor)
[![CI](https://github.com/builtbyadam/actions/actions/workflows/test-license-auditor.yml/badge.svg)](https://github.com/builtbyadam/actions/actions/workflows/test-license-auditor.yml)
[![Release](https://img.shields.io/github/v/release/builtbyadam/license-auditor?sort=semver)](https://github.com/builtbyadam/license-auditor/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Stars](https://img.shields.io/github/stars/builtbyadam/license-auditor?style=social)](https://github.com/builtbyadam/license-auditor/stargazers)

</div>

> 🪞 **This is a generated mirror** of [`builtbyadam/actions`](https://github.com/builtbyadam/actions). Issues and PRs are welcome there.

---

## The problem

A transitive dependency sneaks in under GPL, and your permissively-licensed project now has a compliance problem nobody noticed until legal asked. Full license-scanning platforms are overkill for catching this in CI.

## What it does

Wraps the standard ecosystem tools (`license-checker` for npm, `pip-licenses` for Python) behind a single action with an **allowlist or denylist** of SPDX IDs, and fails the build on a violation.

## Usage

The npm scanner reads **installed** metadata, so install dependencies first:

```yaml
jobs:
  license-audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<sha>
      - uses: actions/setup-node@<sha>
        with:
          node-version: "24"
      - run: npm ci
      - uses: builtbyadam/license-auditor@v1
        with:
          ecosystem: npm
          allow: "MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC"
```

Denylist mode (block specific copyleft licenses):

```yaml
      - uses: builtbyadam/license-auditor@v1
        with:
          ecosystem: npm
          deny: "GPL-3.0, AGPL-3.0, LGPL-3.0"
```

Report-only (collect violations without failing the build):

```yaml
      - id: audit
        uses: builtbyadam/license-auditor@v1
        with:
          deny: "GPL-3.0"
          fail-on-violation: "false"
      - run: echo "Found ${{ steps.audit.outputs.violation-count }} license issues"
```

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `ecosystem` | | `auto` | `npm`, `python`, or `auto` (detect by files present in `working-directory`; scans both when both are present). |
| `allow` | | `""` | Comma/space list of allowed SPDX IDs. Takes precedence over `deny` when non-empty. |
| `deny` | | `""` | List of disallowed SPDX IDs. Used only when `allow` is empty. |
| `working-directory` | | `.` | Directory to scan; also where auto-detection looks. |
| `fail-on-violation` | | `true` | Fail the job on a violation, or report-only when `false`. |
| `include-dev` | | `false` | npm only: include devDependencies. `false` maps to `license-checker --production`. Ignored for Python. |

Provide at least one of `allow` / `deny` — supplying neither is an input validation error.

## Outputs

| Output | Description |
|---|---|
| `violations` | JSON array of `{package, version, license, reason}` objects. |
| `violation-count` | Number of violations found (string integer). |

## Notes

Handles dual-license expressions like `(MIT OR Apache-2.0)` and normalizes SPDX casing. This action **blocks by design** when `fail-on-violation: true` — that's its job. Set it to `false` for an advisory report. Comparison is case-insensitive; parentheses are stripped, expressions split on top-level `OR` / `AND` tokens, and `WITH` exception clauses reduced to their base license.

- **Allowlist mode** (`allow` non-empty, takes precedence): a package violates when none of its license options are allowed; for `AND` expressions every component must be allowed.
- **Denylist mode** (used only when `allow` is empty): for `OR` expressions a violation occurs only if *all* options are denied; for plain or `AND` expressions, any denied component is a violation.
- **Unknown / unrecognized licenses** (e.g. `UNKNOWN`, `Custom: ...`) are a violation in allowlist mode (reason `unrecognized license`) and a warning only in denylist mode.

## Limitations

- **The npm scanner reads installed metadata**, so run your `npm ci` / `npm install` step *before* this action.
- **Private packages are excluded from the npm scan** (`--excludePrivatePackages`): license-checker reports any `"private": true` package — including your own root package — as `UNLICENSED` regardless of its declared license, which would make allowlist mode flag every private repo. You're auditing your dependencies' licenses, not your own.
- License data is only as accurate as each package's published metadata; `license-checker` reports `UNKNOWN` when it can't determine a license.
- SPDX expression parsing is intentionally simple: deeply nested mixed expressions are flattened rather than fully parsed.
- Only npm and Python ecosystems are supported; license aliases / deprecated ids are not normalized to a canonical form.

## License

[MIT](LICENSE)
