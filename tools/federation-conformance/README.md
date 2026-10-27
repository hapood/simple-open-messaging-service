# SOMFP offline validator

Non-normative validation tool **1.0.0-draft.2** for the SOMFP v1 Final Review
release package. This directory is a standalone tool distribution, separate from
the protocol's `spec/` directory. It does not import the reference implementation.

## Standalone use

Distribute this entire directory without `node_modules/`. Obtain the specification
package separately. With Node.js 22.18.0 or newer and npm, run from this directory:

```bash
npm ci --ignore-scripts
npm run conformance -- --spec /absolute/path/to/spec
SOMFP_SPEC_DIR=/absolute/path/to/spec npm test
npm run typecheck
```

Dependency installation needs the npm registry or a populated npm cache. The
validator and regression tests run offline and need no database, backend build,
or repository-root dependency installation. `package-lock.json` pins the tool's
dependencies; do not omit it from the tool distribution.

To validate third-party JSON:

```bash
npm run conformance -- \
  --spec /absolute/path/to/spec \
  --schema urn:somfp:v1:message-query \
  --file ./message-page.json
```

`--spec` is required. Both `--spec` and `--file` resolve relative paths against
the CLI working directory. npm runs the command in this package's directory.
Message pages and individual message schema fragments receive parsed-content
validation in addition to envelope validation. Unknown arguments, missing option
values, and incomplete schema/file pairs fail rather than running package checks.

In a reference checkout, `npm run federation:conformance` at the repository root
calls this same tool with `--spec ./spec`. That convenience command is not
required by either standalone distribution.

## Scope

The default command checks release metadata, all schemas, positive/negative
vectors, parsed message content, selected semantic rules, the HTTP manifest, the
stable error registry, and fixed HTTP Message Signature vectors. Tests exercise
the CLI from unrelated temporary working directories using the supplied spec.

Passing these checks is not runtime interoperability certification. Authorization,
concurrency, durable synchronization, and endpoint WebRTC behavior need separate
implementation tests. The normative protocol text takes precedence over this tool.
