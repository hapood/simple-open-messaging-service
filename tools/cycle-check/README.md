# Backend cycle check

This private, standalone npm package runs Madge against the backend source tree.
It is not a workspace and does not compile application code. Its local TypeScript
5.9 dependency satisfies Madge 8's peer requirement, while the backend and both
frontends use TypeScript 6.0. Do not override Madge's peer requirement or install
its dependencies into the application package.

From the repository root:

```sh
npm ci --prefix tools/cycle-check
npm run check:cycles
```

The root script forwards to `check.mjs`, which locates the backend source tree
relative to its own file, independent of the caller's working directory. It passes
raw `NodeNext` module and resolution options to Madge's API so packages with
conditional exports resolve correctly. Passing a tsconfig path to Madge 8 instead
causes parsed numeric enums to be converted a second time by its resolver, losing
these settings. No application compiler configuration or dependency is patched.

The gate includes type-only imports and fails on cycles, unresolved imports,
analysis errors, or an empty source tree; skipped imports must not silently weaken
the check. For isolated checks, the script accepts an
optional source-directory argument. Run its regression fixtures with:

```sh
npm test --prefix tools/cycle-check
```

Commit the tool's lockfile; its node_modules directory remains ignored. CI installs
this package separately, runs the regression fixtures, and then runs the root gate.
