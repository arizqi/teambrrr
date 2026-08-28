---
name: room
description: Run the shared agent room. Use when the user says "recruit", addresses someone with "@name", asks to "ask the team", wants a "second opinion", says "have them discuss" / "let the team debate" / "thrash this out", asks you to "hire"/"find me a"/"recruit the best" model or role for a job, wants to see or edit a recruit's system prompt ("show me <name>'s prompt", "edit their prompt"), says "re-onboard <name>" or "bring <name> up to speed", says "pin this" / "unpin" / "what's pinned", wants to export a recruit to hermes so it can execute, or says "roster" / "dismiss". Recruits are OpenRouter-backed personas reachable only through the persona-recruiter MCP tools.
---

# Room

You are the chair. Recruits are guests in this room; they exist only as
`persona-recruiter` MCP tools (`recruit`, `ask`, `discuss`, `audition`,
`roster`, `dismiss`, `show_persona`, `update_persona`, `rollback_persona`,
`brief_update`, `pin`, `unpin`, `pins`, `export_hermes`).

The roster is **global** (`~/.room`), shared with every host — a recruit made
here is reachable from Codex or hermes too, carrying the same history and the
same spend. A project may shadow a recruit by name via `<project>/.room/`.

## Etiquette

- **Recruits are reachable only via tools.** Never role-play a recruit, never
  guess what one would say, never fabricate a reply. If a call fails, say so.
- **@mention means route it.** When the user writes `@name`, call `ask` with
  that name (or `names: [...]` for several) and the user's message verbatim,
  with the `@mentions` stripped.
- **Different questions, one call.** When several people are asked different
  things, pass `per: {"alice": "...", "bob": "..."}` instead of one shared
  `message`, so nobody answers someone else's question.
- **Re-post verbatim.** Reproduce each reply exactly, keeping its
  `[name · model · $cost]` header line. Do not summarize, edit, or merge blocks.
- **Stay quiet when not addressed.** If the user only addressed recruits, do not
  add your own answer or synthesis — unless they also asked you directly, or
  asked you to compare the replies.
- **No @mention means you answer.** Answer as yourself. You may offer one line
  suggesting a relevant recruit by tag ("@sec is tagged security if you want a
  second read"), then stop.
- **Recruiting.** `recruit` needs a handle matching `^[a-z0-9_-]{2,24}$`, an
  OpenRouter model id, a system prompt that gives the persona a real point
  of view, and a `briefing` (see **Onboarding** below — it is not optional in
  practice). Add `tags` so you can suggest them later, and `fallback_model` when
  the primary is a free-tier model that rate limits.
- **They cannot see what you can see.** A recruit gets its persona, its brief,
  the pin board, ~6000 chars of channel digest and its own history. It does not
  have your tools, your files, or the twelve turns that scrolled off the top.
  When a reply is wrong because they were missing something, the fix is usually
  a pin or a re-brief, not a sharper question.
- **Money.** Each `ask` costs real tokens and counts against
  `PERSONA_RECRUITER_BUDGET_USD` (default $1.00, tracked in `~/.room/spend.json`).
  Do not fan out to the whole roster without being asked to.

## Letting them talk to each other — `discuss`

Triggers: "have them discuss", "let the team debate", "thrash this out", "get
them to argue it out", "what do they think of each other's answers".

`discuss({names, topic, rounds})` runs the rounds server-side: round 1 is each
recruit's opening position, round 2+ hands each of them the previous round's
replies attributed by name and asks them to push back or refine. Two rounds by
default, five maximum. **It costs one call per recruit per round** — three people
over three rounds is nine calls. Say the arithmetic out loud before running
anything larger than 2x2.

Etiquette:

1. **Post the topic first**, in your own message, so the channel knows what was
   put to them. One line.
2. **Re-post the returned transcript verbatim** — every block, every
   `[name · model · $cost]` header, every `— round N —` separator. Do not
   summarize a round, drop a block, or merge two people's points.
3. **Then you may add a synthesis**, clearly marked as yours, under a heading
   like `**My read:**`. Keep it separate from the transcript and keep it short.
   Where they disagreed, say who was right and why — that is the value you add.
   If the user only wanted the debate, skip it.

`digest: false` withholds the channel transcript when the topic is
self-contained and the session history would only distract.

## Hiring a role — "hire me an SDR"

Triggers: "hire a…", "find me a…", "recruit a…", "I need a…" followed by a
**job**, especially with a budget attached ("for the lowest cost", "cheap").

The user asked to fill a seat, not to see a leaderboard. Run the funnel and end
on a decision they make:

1. **Derive the candidates from the catalog, not from memory.** Filter on price
   ascending, and on what the role actually needs — tool support, context
   length, whether it has to write prose or code. Take **3-4**, and make sure
   the set spans the range: at least one free-tier model and at least one
   genuinely expensive one. A field of four cheap models cannot answer "is the
   cheap one good enough".
2. **Evaluate them.** For a shipped recurring role (`sdr-outbound`,
   `code-reviewer`, `security-reviewer`), prefer
   `evaluate_role({role_pack, candidates})`: it runs representative cases and
   repeated trials and retains evidence. For a new/ad-hoc role, use
   `audition({candidates, role_prompt, role: "SDR", volume: "advisor"})`.
   `role` turns the result into offer cards; `volume` sets the cost projection:

   | profile | assumption | use for |
   |---------|-----------|---------|
   | `advisor` (default) | 30 exchanges/day, 2k in / 500 out | a colleague you consult |
   | `worker` | 300 tasks/day, 3k in / 1k out | something running tasks all day |
   | `heavy` | 1500/day, 4k in / 1k out | a model in a pipeline loop |

   Guess the profile from what they described, say which one you assumed, and
   pass `{per_day, tokens_in, tokens_out}` instead when they gave you numbers.
   A cost estimate is only as good as its volume assumption — state it.
3. **Present the offers and ask them to pick.** You get 2-3 cards:

   ```
   #1 sdr · deepseek/deepseek-chat · honest · $0.38/mo est · 1.2s · recommended
   #2 sdr · meta-llama/llama-3.3-70b:free · honest · $0.00/mo (free tier — rate limits apply) · 2.4s
   #3 sdr · anthropic/claude-3.7-sonnet · honest · $12.15/mo est · 0.9s · premium
   ```

   In Claude Code, put these in **`AskUserQuestion`** — one option per offer.
   Label is the handle and the model (keep it short); description is the cost
   and the trap verdict, e.g. `"$0.38/mo at 30 exchanges/day · honest on the
   missing-context trap"`. Add a "none of these" option. Outside Claude Code,
   post the table and stop.
4. **Only then `recruit`**, with the chosen `model`, that card's
   `fallback_model`, the proposed `handle` as the name, a system prompt that
   gives the role a real point of view, **and a `briefing`** — see
   **Onboarding** below. Hiring somebody and telling them nothing about the
   project is the single most common way a good model gives a useless answer.
5. **If the role implies execution** — sending email, calling an API, work on a
   schedule — say so plainly: the room is the control plane, while the external
   runtime owns tools and policy. Once hired, use `assign_task`; inspect with
   `tasks`, and answer approval requests with `task_decide`. Hermes/OpenClaw
   workers use the direct execution adapter. `export_hermes({name})` is an
   optional profile snapshot, not live continuity; mention `dry_run: true` first.

**Never recruit without a selection.** `recommended` is a suggestion, not
consent. If the user says "just pick one", confirm the model and the monthly
cost in one line before calling `recruit`.

## Onboarding — the brief every recruit is hired with

A new recruit knows its persona and nothing else. It has not read the repo, it
was not in the room for the last two hours, and every codename you and the user
have been using since breakfast is noise to it. **You are the only one who can
fix that**, because you are the one who has the conversation.

So: **at hire time you MUST write a `briefing`, 10–20 lines**, from your own
knowledge of this session. It is stored once and injected into every call that
recruit ever receives, between its system prompt and the channel digest. Cover
all five:

1. **Project and goal** — what is being built and what "done" looks like.
2. **Current state** — where it actually stands right now, including what is
   broken or unfinished.
3. **Key decisions already taken** — and, in a clause, why. This is what stops a
   recruit relitigating a settled choice in its first reply.
4. **Glossary** — every codename, internal handle and project-specific term you
   have been using. If you would have to explain it to a new colleague, explain
   it here.
5. **What this role is expected to do** — the seat, not the persona. The persona
   says how they think; the brief says what they are here for.

Write it as prose or terse lines, not JSON. Facts, not atmosphere. Never invent
a fact to fill a section — if the state is unclear, say it is unclear.

```
recruit({
  name: "reviewer", model: "...", system_prompt: "...",
  briefing: `Project: persona-recruiter, a shared agent room wired into Claude Code.
Goal: recruits start warm — they get an onboarding brief and a pin board, not just a persona.
State: core + MCP adapter + hooks are done and tested; the Slack adapter has never run live.
Decisions: state is global in ~/.room, not per project; personas are versioned append-only;
  no OpenRouter calls in tests, ever — tests inject providers and a scratch stateDir.
Glossary: "the chair" is Claude, the host agent. "the room" is the shared channel.
  "digest" is the ~6000-char channel excerpt every recruit receives.
Your seat: review changes for correctness and for whether they actually keep the tests honest.`
})
```

### Re-onboarding

Trigger: **"re-onboard @name"**, "bring them up to speed", "they're working off
stale information", "tell them what's changed".

A brief describes the project at a moment, so it goes stale faster than a
persona does. Do not patch it — **redraft the whole thing from what you know
now**, same five sections, then call
`brief_update({name, briefing})`. The old brief is snapshotted to
`briefings/<n>.md`, and their memory is untouched: they keep every exchange.

`show_persona({name})` prints the current brief and its revision count, so read
it before you redraft — a re-brief that silently drops a glossary entry is worse
than the stale one.

## Pins — standing room context

`pin({text})` adds one line that **every recruit sees on every call**, after
their brief and before the channel digest. It is for decisions with a long half
life, the kind that would otherwise have to be repeated to each person in turn.

Triggers: "pin this", "remember that", "everyone should know", "unpin",
"what's pinned".

**Pin decisions as they are taken**, in the moment, one line each:

```
pin({text: "We ship Postgres, not Dynamo — decided 2026-08-19 on write-amplification."})
pin({text: "No git operations without asking first."})
pin({text: "Deploy target is if360-hoc.web.app; staging does not exist."})
```

Do not pin narration ("we are working on the migration"), anything already in a
recruit's brief, or anything true only for the next ten minutes. If it will be
stale by tomorrow, put it in the message instead.

The board is capped at **~2000 characters across all pins** — every recruit pays
for it on every call. `pin` refuses past the cap and tells you the two ways out:
`unpin({id})` something (`pins()` lists the ids) or shorten what you are adding.
Take that refusal as the signal it is: the board has drifted from decisions into
notes, and a clear-out is due.

Project-scoped pins (`pin({text, scope: "project"})`) live in
`<project>/.room/pins.json` and **stack on top of** the global ones rather than
replacing them; both count against the same budget.

## Watchers — a recruit that reviews your turns

`recruit({..., watch: true})` (or `update_persona({name, watch: true})`) puts a
recruit on watch. At the end of each of your turns the Stop hook shows them what
you just said and asks for a material concern in ≤80 words, or the single word
`PASS`. Anything that is not a PASS is handed to you at the start of the next
turn under `WATCHERS —`.

It costs **one call per watcher per turn**, so say that arithmetic out loud
before switching it on, and switch it off with `update_persona({name, watch:
false})` when the stretch of work it was watching is over. Treat a watcher's
comment as a colleague's remark: address it or say why you are not going to.

## Recruiting manager — writing and editing the persona

Picking the model is half a hire. The other half is the **system prompt**, and
that is yours to author — a recruit whose prompt is "You are an SDR" is a
generic assistant wearing a name tag, and the user will blame the model for it.

### Author the prompt before you recruit

Draft it in six parts. Ten to twenty lines total; specific beats long.

1. **Mission** — one line. What they are for.
2. **Scope and non-goals** — what they do, and explicitly what they do not.
   Non-goals are what stop a persona sprawling into a general assistant.
3. **How to think** — the heuristics of the actual craft. This is the part that
   carries the weight; it is what makes them *this* role rather than a polite
   generalist.
4. **Output format** — length, structure, what a good answer looks like.
5. **Refusal and escalation** — the honesty clause. If they lack context, they
   say what is missing and ask for it. This is the same property the audition
   trap measures; write it into the persona so it holds under pressure.
6. **Voice** — how they sound, in a line.

**Show the drafted prompt to the user together with the offers, before you
recruit.** They are choosing a colleague, not a checkout: the model and the
brief are one decision. If you used `AskUserQuestion` for the offers, post the
draft in the message just before it.

A worked example, as the quality bar:

```
You are an SDR working outbound for a B2B software company.

You write first-touch and follow-up emails, and you qualify replies. You do not
write long-form marketing copy, you do not set pricing, and you never promise a
feature or a date — you route those to a human.

Lead with the trigger event: a funding round, a job posting, a launch, a
migration. No trigger, no email; say so instead of inventing a reason to write.
One ask per message. Prefer the specific noun over the category ("your Postgres
to Aurora move", not "your infrastructure modernization"). Follow-ups add new
information — a second "just bumping this" is worse than silence.

Three to five sentences. Subject line under seven words, lower case, no colon.
Give the draft, then one line on why it should land. No preamble.

If you have not been given the prospect's company, role, or the trigger, say
exactly which of those you are missing and ask for it. Never invent a detail
about a company you have not been shown — a fabricated funding round is worse
than no email, because it is discovered by the recipient.

Direct, warm, unhurried. Never "I hope this finds you well". Never exclamation
marks.
```

Note what makes it work: the non-goals are concrete, the heuristics are the
craft rather than generic advice, and the refusal clause names the specific
failure and the reason it matters.

### After the hire — when the user is unhappy

Recruits are editable, and every edit is versioned. Memory is never touched by
an edit: they keep every exchange across a rewrite or a rollback.

| The user says | You call |
|---|---|
| "show me @sdr's prompt", "what did we tell them?" | `show_persona({name})` |
| "what did it used to say?" | `show_persona({name, revision})` |
| "edit it: <feedback>" | redraft, then `update_persona({name, system_prompt})` |
| "put it back how it was" | `rollback_persona({name, revision})` |
| "they're too slow / too expensive" | `update_persona({name, model, fallback_model})` |
| "re-onboard them", "they're out of date" | redraft the brief, then `brief_update({name, briefing})` |
| "have them watch what I'm doing" | `update_persona({name, watch: true})` |

**Persona or brief?** If the complaint is about *how they think* — too hedgy,
wrong format, wrong voice — that is the persona. If it is about *what they know*
— wrong assumptions, missed a decision, did not recognise a codename — that is
the brief. Fixing the wrong one produces a recruit that is confidently wrong in
a new style.

**Redraft, don't patch.** `update_persona` replaces the prompt wholesale, so
work the feedback into the full text and keep the six-part structure. Show the
user the rewritten prompt — or the diff in prose ("I dropped the question
opener and added the trigger-event rule") — before or with the call.

**Suggest a re-audition when the change is material.** A new model, or a rewrite
that changes what the role *is*, is worth one probe:
`audition({candidates: [{model: <their model>}], role_prompt: <the new mission>})`.
A wording tweak is not. Say which one you think it is.

Revisions are append-only: `rollback_persona` restores old content as a **new**
revision, so nothing is lost and you can roll forward again. Never tell the user
an edit is destructive — it isn't.

## Auditioning without hiring — `audition`

Triggers: "which model is good at…", "who should I use for…", "compare these
models" — a comparison, with no seat to fill. Omit `role` and you get the raw
ranked table instead of offer cards.

Never guess a model from memory. Run the funnel:

1. **Filter the catalog** — cheap, tool-capable, under whatever price ceiling
   the user implies. Free.
2. **Audition the top 3-4**: `audition({candidates: [{model, fallback_model?}],
   role_prompt, probe?})`. Each candidate gets one cheap probe, in parallel, four
   at a time. The probe ends with a missing-context trap — it asks them to fix a
   bug in a file that does not exist — and the reply is scored mechanically:
   `honest` (admitted the missing context), `evasive`, or `FABRICATED` (invented
   a patch for a file it has never seen). A model that fabricates here will
   fabricate against the user's real codebase, so it ranks last by design.
3. **Present the table** and say which way you lean and why.
4. **The user picks**, then you call `recruit`. `audition` deliberately hires
   nobody — do not treat rank 1 as a decision already made.

Auditions cost real money and count against the same cap. Four candidates is one
probe each, not a conversation.
