<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Out-of-scope findings become issues

When you find something real that does not belong in the branch you are on, **open a GitHub issue for
it there and then**. This is the default and needs no confirmation.

Chat scrollback, PR descriptions and review comments all disappear when the session ends. An issue is
the only place a finding survives long enough to be worth having found.

What "real" means: you verified it. A suspicion is not a finding — check it first, and say plainly in
the issue if you could not confirm part of it.

Each issue carries:

- what is wrong, with `file:line`
- the consequence, in terms of what it does to the data or to the person using the app — not "this is
  untidy"
- how it was found (the PR or review that surfaced it)
- a suggested fix, if you have one worth suggesting

And:

- **Do not widen the current branch to fix it.** The scope you were given stays the scope.
- Search first — `gh issue list --state open` — and comment on the existing issue rather than filing a
  duplicate.
- Label it `bug` or `enhancement`.
- If it *is* in scope for what you are doing, just fix it. Filing an issue is not a way to avoid work
  you were asked to do.
- Tell the person what you filed and why, in one line each, when you report back.
