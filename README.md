# mend — one patch tool for every AI edit format

`mend` applies an edit that an AI model wrote to a tree of text files. Models write edits in
four formats — a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A
patch format, and text-editor tool calls as JSON — and `mend` reads each one exactly as
[`SPEC.md`](SPEC.md) (version 1) says. Every file is changed or nothing is.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- The working directory is the root of the tree; every path in a patch is relative to it.
- `PATCH` is the patch file, relative to the working directory. When absent or `-`, the patch
  is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a`, `json`,
  or `auto` (the default), which detects the format per SPEC section 4.
- `--check` does everything but write: same output and exit code, no file created, changed
  or deleted.
- `--strict` matches lines exactly (tier 0 only, SPEC section 5).
- Options and `PATCH` may come in any order; `--` ends the options.

Node 22, standard library alone — no dependencies, no install step.

## Exit codes and output

Standard output holds lines, each ended by `\n`, and nothing else. Standard error is never
compared.

- Exit 2, one line: `error: usage`, `error: no-patch`, `error: format`, or
  `error: parse <N>` (1-based patch line). Usage wins over everything; a parse error is
  reported before any file is looked at.
- Exit 1, nothing written: one `error: <code> <path>` line per failed edit, in patch order
  (`no-match`, `ambiguous`, `missing`, `exists`, `unsafe`), then `failed: <k> of <n> edits`.
  Edits after a failed one still run, so every failure is reported.
- Exit 0: one line per changed path, in byte order — `A <path>`, `D <path>`, `M <path>`,
  `R <old> -> <new>` for a move — then `ok: <n> files` (`ok: 1 file` for one, `ok: 0 files`
  for a patch that changes nothing). A file whose bytes are unchanged is not listed.

## How it works

- **Line matching (SPEC 5).** Old lines are found at the first of three tiers at which they
  occur: exact, trailing whitespace ignored, leading and trailing whitespace ignored.
  Context lines are always written back as the file's own matched lines; at tier 2, other new
  lines are re-indented from the patch's indentation to the file's.
- **Unified diffs (SPEC 6).** Sections from `diff --git` or `---`/`+++` pairs; creation,
  deletion, rename and change; hunks apply in order with the `d` offset, each taking the
  occurrence nearest its (possibly wrong) line number, ties to the earlier one. Empty old
  sides insert; `\ No newline at end of file` decides the final line break.
- **SEARCH/REPLACE (SPEC 7).** Blocks take the nearest non-blank, non-fence line above them
  as their path (or the previous block's); a unique occurrence is required, otherwise
  `ambiguous`; an empty old side creates the file.
- **V4A (SPEC 8).** `Add` / `Delete` / `Update` sections, optional `*** Move to:`, chunks
  with anchors and a cursor that only moves forward, `*** End of File` anchoring a chunk to
  the file's end.
- **JSON (SPEC 9).** One array or JSON Lines of `create` / `str_replace` / `insert` edits,
  with CRLF-aware replacement.
- **Atomicity (SPEC 10).** Edits apply in patch order to the tree as earlier edits left it;
  every path is safety-checked before anything else about it; when any edit fails, no file
  is written at all.

## Files

- `main.ts` — the CLI (all ten SPEC sections).
- `runner.ts` — the kit's trial runner (unchanged from the kit).
- `check.ts` — run the public practice set: `node check.ts <practice.json>` (the kit carries
  it at `program/generator/practice.json`).
- `SPEC.md` — the specification this entry implements.
- `LICENSE` — MIT.

## Validation

- Public practice set: **100 of 100 checks pass (practice score 1000)**.
- Determinism: every practice check run twice produces byte-identical exit code, stdout and
  files (100/100).
- 55 hand-written edge cases covering SPEC sentences the practice set does not (usage and
  parse errors, unsafe paths, no-newline-at-end, CRLF, `--check`, `--strict`, V4A anchors
  and end-of-file chunks, move output ordering): **55/55 pass**.

## Known limits

- A patch that creates a file where a directory of the same name stands (or vice versa)
  fails at write time; the specification does not define file/directory conflicts.
- A few degenerate readings are implemented literally from SPEC where no practice check
  distinguishes them (for example a hunk with an empty body, or a `*** End of File` line
  with no chunk in progress, which is a parse error).
