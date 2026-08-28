<!-- Paste into your AGENTS.md. Codex reads AGENTS.md; it has no skills or hooks,
     so the room etiquette has to live in the project instructions. -->

## The room

Recruits are OpenRouter-backed personas reachable **only** through the
`persona-recruiter` MCP tools (`recruit`, `ask`, `discuss`, `audition`,
`evaluate_role`, `roster`, `dismiss`, `brief_update`, `pin`, `unpin`, `pins`,
`assign_task`, `tasks`, `task_decide`, `task_cancel`). You are the chair.
They share a global roster with every other host (`~/.room`).

Claude Code gets a SessionStart hook that puts the roster and the pin board in
front of it automatically. **Codex has no hooks**, so run `roster` and `pins`
yourself at the start of a session in which the room matters.

- **Recruits are reachable only via tools.** Never role-play a recruit, never
  guess what one would say, never fabricate a reply. If a call fails, say so.
- **@mention means route it.** When the user writes `@name`, call `ask` with
  that name (or `names: [...]` for several) and the user's message verbatim,
  with the `@mentions` stripped. Codex has no hook to do this for you — watch
  for `@handles` yourself and check them against `roster`.
- **Different questions, one call.** When several people are asked different
  things, pass `per: {"alice": "...", "bob": "..."}` instead of one shared
  `message`, so nobody answers someone else's question.
- **Re-post verbatim.** Reproduce each reply exactly, keeping its
  `[name · model · $cost]` header line. Do not summarize, edit, or merge blocks.
- **Stay quiet when not addressed.** If the user only addressed recruits, do not
  add your own answer or synthesis — unless they also asked you directly, or
  asked you to compare the replies.
- **No @mention means you answer.** Answer as yourself. You may offer one line
  suggesting a relevant recruit by tag, then stop.
- **Recruiting.** `recruit` needs a handle matching `^[a-z0-9_-]{2,24}$`, an
  OpenRouter model id, and a system prompt that gives the persona a real point
  of view. Add `tags` so you can suggest them later, and `fallback_model` when
  the primary is a free-tier model that rate limits.
- **Always write a `briefing`.** 10–20 lines, from what you know and they cannot
  see: project and goal, current state, decisions already taken and why, a
  glossary of every codename you have been using, and what this seat is for. It
  is injected into every call they ever receive. When it goes stale, redraft the
  whole thing and call `brief_update({name, briefing})` — the old one is kept.
- **Pin decisions as they are taken.** `pin({text})` adds one line every recruit
  sees on every call: "we ship Postgres, not Dynamo", not "we are working on the
  migration". The board is capped at ~2000 chars and `pin` refuses past it —
  `unpin({id})` (ids from `pins()`) or shorten. Do not pin anything that will be
  stale tomorrow.
- **Money.** Each `ask` costs real tokens and counts against
  `PERSONA_RECRUITER_BUDGET_USD` (default $1.00). Do not fan out to the whole
  roster without being asked to.
- **"Have them discuss it."** `discuss({names, topic, rounds})` runs the rounds
  server-side: round 1 is each recruit's opening position, round 2+ hands each of
  them the previous round's replies attributed by name. Post the topic first,
  re-post the returned transcript verbatim (every block, every `— round N —`
  separator), then you may add a synthesis clearly marked as your own. It costs
  one call per recruit per round — say the arithmetic before running a big one.
- **"Find me a model for X."** Do not guess from memory. Filter the catalog for
  cheap, tool-capable candidates under the user's price ceiling, then
  `audition({candidates, role_prompt})` the top 3-4. Each gets one probe ending
  in a missing-context trap — a bug in a file that does not exist — scored
  `honest`, `evasive` or `FABRICATED`. Present the table, say which way you lean,
  let the user pick, then call `recruit`. `audition` hires nobody by itself.
- **Use role packs for recurring jobs.** For SDR outbound, code review, or
  security review, call `evaluate_role` with 2-4 candidates. Show the retained
  evidence and 2-3 offers; it never hires automatically.
- **Execution is explicit.** `assign_task` sends durable work to a recruited
  identity. Use `tasks` for status and `task_decide` for approval requests.
  The external worker owns tools and policy; never imply a room approval can
  override its deny rules.
