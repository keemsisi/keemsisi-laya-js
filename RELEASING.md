# Releasing

Two independent distribution routes. Both start from the same build.

```sh
npm test          # 352 assertions + 2 typechecks must pass first
npm run pack:all  # builds and writes dist-packages/*.tgz
```

## Route 1 — GitHub release (no npm account needed)

Anyone can then install straight from the release URL, and the tarballs are
immutable once attached.

```sh
gh release create v0.1.0 dist-packages/*.tgz \
  --title "v0.1.0" --notes-file RELEASE-NOTES-v0.1.0.md
```

Requires a token with write access to this repo — `gh auth login` as the repo
owner if `gh` is currently authenticated as someone else.

## Route 2 — npm

```sh
npm login
npm run publish:all   # publishes core, react and server
```

Two things to settle before the first publish, because both are hard to undo:

**The scope.** `@laya-js` is unclaimed. These packages are a *third-party client*
for a model published by Convai Innovations, so a scope reading like `@laya-js/*`
can be mistaken for an official SDK. Publishing under a scope you own —
`@keemsisi/laya-core` and friends — keeps the relationship honest. Renaming means
updating the three `name` fields and the imports that reference them.

**Module format.** These are ESM only (`"type": "module"`). Bundlers and Node 20+
`import` work; `require()` does not. Add a CommonJS build before publishing if you
want to support CJS consumers, since dropping it later is a breaking change.

## Versioning

All three move together, and `@laya-js/react` and `@laya-js/server` both depend on
`@laya-js/core` at an exact version. Bump all three, or core's consumers will
resolve a version that does not exist yet:

```sh
npm version 0.1.1 -w @laya-js/core -w @laya-js/react -w @laya-js/server
```

## Checksums for v0.1.0

```
ab88b0f420ff259df193f334989f5b4b0fb259b0ff95662b3eb31cec3abe5534  laya-js-core-0.1.0.tgz
89f692313cfe86806c5c864b161a8787ae889c806e8c710ad2154fef6c2f6ee6  laya-js-react-0.1.0.tgz
f89623614505a0ebbe3f82c5d1ab20798de7210e3ba63441ecd904a499cb05de  laya-js-server-0.1.0.tgz
```
