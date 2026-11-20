# Agent instructions

These rules apply throughout this repository to Codex, Claude Code, and other coding agents. Keep changes consistent with the surrounding code and focused on the requested work.

## TypeScript

- Follow the existing TypeScript, ESM import, and Biome conventions. Use `import type` for imports used only as types.
- Prefer clear names and small, direct functions. Replace unexplained numeric offsets or flags with named values when the name makes their meaning clearer.
- Keep types precise. Narrow unknown values at boundaries; avoid `any`, unsafe assertions, and non-null assertions used to hide an unchecked assumption.
- Preserve the existing package boundaries.

## API documentation

- Use JSDoc comments (`/** ... */`) immediately before the declaration they describe. Follow the official [JSDoc reference](https://jsdoc.app/) and [TypeScript JSDoc guidance](https://www.typescriptlang.org/docs/handbook/jsdoc-supported-types.html). Use [TSDoc parameter syntax](https://tsdoc.org/pages/tags/param/) for `@param name - description`.
- Document public APIs and non-obvious internal contracts. A useful single sentence is enough for a simple declaration; do not add a block to every private helper or local variable.
- Start with what the caller needs to know. Explain behavior, constraints, units, defaults, side effects, and ownership where they matter. Describe who releases a GPU resource and when callers must pass a new object or array.
- Keep type information in TypeScript. Do not repeat it with JSDoc `@type`, `@typedef`, or `{Type}` annotations on parameters and return values in `.ts` files.
- Add `@param` and `@returns` when they explain meaning beyond the signature. Avoid entries such as "The options" or "The result." Omit `@returns` for `void` functions.
- Use `@default` for meaningful configurable defaults, `@throws` for actual failure conditions, `@deprecated` with a replacement, and `{@link ...}` for related declarations. Follow the existing tag style and keep every claim consistent with the implementation.
- Add a short `@example` only when it makes usage or behavior clearer. Keep examples valid and small.

## Implementation comments

- Explain why a non-obvious decision is necessary, what invariant must hold, or what external constraint the code handles. In shader and GPU code, explain meaningful layout, transform, precision, draw-order, or lifetime constraints.
- Use `//` for local implementation notes. Use JSDoc for declaration documentation. Put explanations next to the code they clarify.
- Do not narrate obvious operations: avoid comments such as "Loop over cells," "Create a buffer," "Set the value," or "Return the result."
- Avoid section banners, numbered step narration, repeated type signatures, commented-out code, and change-history notes. Do not add comments just to fill space or label every few lines.
- A one-line comment is fine when it adds necessary information. Length is not the test: if removing the comment loses no useful information, remove it or improve the code's names instead.
- Update or remove affected comments in the same change as the code. Preserve useful explanations of intent; delete obsolete claims and duplicate explanations.
- Leave a TODO only for a specific unresolved task, with enough context to act on it and an issue link when available.

## Review and validation

- Check that names, types, comments, examples, and README guidance agree and that each explanation earns its place.
- For code changes, run `pnpm check` and the relevant tests. Run `pnpm test` for logic changes and `pnpm test:browser` for rendering changes when WebGPU is available. Report any checks that could not run.
- For documentation-only changes, check the diff and links; do not run unrelated rendering tests.
