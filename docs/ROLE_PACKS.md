# Role packs

Role packs are portable, versioned job definitions for evaluating candidate models before recruitment. A pack contains the role mission and prompt, workload assumptions, permission metadata, realistic test cases, repeated-trial settings, and deterministic evaluators.

The evaluator remains a dependency-free library: it performs no network calls, writes no state, and recruits nobody. The room and MCP adapters expose it through `evaluateRole()` and `evaluate_role`, supplying the existing provider, catalog validation, price lookup, spend ledger, and offer rendering. The user still decides whether to recruit a result.

## Included packs

The repository ships three reference packs:

- `role-packs/sdr-outbound.json` — evidence-led personalization, missing-account honesty, and structured reply qualification.
- `role-packs/security-reviewer.json` — authorization review, missing-source honesty, and refusal of unauthorized production exploitation.
- `role-packs/code-reviewer.json` — concurrency regression detection, missing-helper honesty, and restraint on a correct change.

Each pack has three cases and three trials by default. These are examples and quality bars, not claims that a model is certified for production.

## Schema version 1

Role packs are strict JSON objects. Unknown keys are errors at every schema level.

| Field | Meaning |
|---|---|
| `schema_version` | Must be `1`. Future incompatible schemas use a new integer. |
| `id`, `name`, `version` | Portable slug, display name, and semantic version. IDs cannot contain paths. |
| `mission` | Stable definition of the job and desired outcome. |
| `default_volume` | `per_day`, `tokens_in`, and `tokens_out` assumptions for later cost projection. |
| `candidate_requirements` | Model patterns, minimum context, capabilities, and author notes. These are discovery metadata; this library does not query a catalog. |
| `trial_count` | Repetitions per case, from 1 through 5. |
| `prompt_template` | The candidate's system prompt. Supported placeholders are listed below. |
| `permissions` | Optional tools, data, network mode, approval boundaries, and notes. Metadata only; the execution host must enforce it. |
| `cases` | One through 12 tasks, each with an ID, prompt, optional context, and optional evaluator selection. |
| `evaluators` | One through 40 deterministic criteria with IDs, weights, and optional case selection. |

Allowed prompt placeholders are:

- `{{mission}}`
- `{{case.id}}`
- `{{case.name}}`
- `{{case.prompt}}`
- `{{case.context}}`

They are plain substitutions, not a template programming language. No expressions, includes, environment variables, file reads, or JavaScript are supported.

An evaluator applies to every case unless it has `case_ids`. A case may further narrow evaluation with `evaluator_ids`; both filters must allow the evaluator.

## Evaluators

All automated scores are in `[0, 1]` and include auditable evidence.

| Type | Configuration | Behavior |
|---|---|---|
| `must_contain` | `values`, optional `all`, `case_sensitive` | Proportional all-of score by default, or binary any-of score. |
| `must_not_contain` | `values`, optional `case_sensitive` | Zero if any forbidden text appears. |
| `regex` | `pattern`, optional `flags` | Binary match using a deliberately restricted regular-expression subset. |
| `max_words` | `max` | Full credit within the limit, then `max / actual`; empty output is zero. |
| `required_sections` | `sections`, optional `case_sensitive` | Proportion of line-oriented headings found. Markdown headings and optional colons are accepted. |
| `honest_missing_context` | `missing_items` | Full credit only for a clear missing-context admission without an invented patch, access claim, or verification claim. |
| `valid_json` | none | Requires the entire response to parse as JSON. Fenced JSON fails intentionally. |
| `manual` | `instructions` | Produces a pending result. A required manual criterion makes a candidate ineligible until an external system records a decision. This engine does not impersonate a human or model judge. |

Every evaluator requires a positive `weight`. Optional `min_score` controls its pass threshold and defaults to `1`. A zero on an evaluator marked `required` or `fatal` forces the composed quality score to zero. Other zeroes use a small floor in the geometric mean, so they hurt severely without silently becoming fatal.

The `honest_missing_context` evaluator is intentionally conservative and English-language. It is useful as a deterministic safety tripwire, not a semantic proof. Authors should include domain-specific `must_not_contain` checks for dangerous false claims as the shipped packs do.

## Evaluation and ranking

`evaluateRolePack()` accepts one to four candidates. It runs every candidate against every case for the configured number of trials through a pool of at most four concurrent calls.

For each trial it preserves:

- Requested and actual model IDs, including fallback state
- Full bounded response text
- Cost, latency, and token usage when supplied by the callback
- Every criterion score, match, pass decision, and explanation
- Provider errors rather than throwing away the candidate's record

Candidate quality is a weighted geometric mean across evaluator averages. This prevents strength on one dimension from arithmetically hiding weakness on another. Rows also report score variance, normalized consistency, pass rate, average latency, total known cost, fatal/manual status, per-case trials, and the original evidence.

Ranking order is deterministic: eligible status, quality, pass rate, consistency, known cost, latency, then model ID. Latency and cost are reported and used as tie-breakers; they do not dilute role quality. Returned rows are shaped for offer generation. The room integration renders up to three eligible offers; failed and manual-pending candidates remain visible as evidence but cannot become selectable hires. No recruit is created.

## Usage

```js
import { evaluateRolePack, loadRolePack } from './core/role-packs.mjs';
import { callWithRetry } from './core/provider.mjs';

const pack = loadRolePack('./role-packs/code-reviewer.json', {
  root: './role-packs'
});

const result = await evaluateRolePack({
  pack,
  candidates: [
    { model: 'provider/model-a', params: { temperature: 0 } },
    { model: 'provider/model-b', fallback_model: 'provider/model-c' }
  ],
  call: (request) => callWithRetry({ ...request, provider })
});

console.log(result.rows);
```

For a completely offline run, inject a fixture callback:

```js
const call = async ({ name, model, messages }) => ({
  text: fixtureFor({ name, model, messages }),
  latency_ms: 12,
  cost: 0
});
```

The callback receives `{name, model, fallback_model, messages, params, price, retryDelayMs}`. It may return `{text, model, fellBack, latency_ms, cost, usage}`. This matches the existing retry seam without importing or binding the role-pack engine to it.

Run the focused offline suite with:

```sh
node test/role-packs.mjs
```

## Authoring guidance

1. Define a narrow job with an observable mission. Avoid personality-only prompts.
2. Include at least three different case classes: representative work, missing-context honesty, and a refusal or restraint case.
3. Use realistic context, but no real secrets, customer data, or proprietary source code in a public pack.
4. Make dangerous behavior fatal: fabricated access, unauthorized action, invalid required output, or failure to admit absent evidence.
5. Use anchored deterministic checks. Do not make success depend on one vague keyword.
6. Repeat trials. A model that passes once and fails once is not equivalent to a consistently safe model.
7. Keep permission metadata least-privileged and list every consequential operation under `approval_required`.
8. Version behavioral changes. If prompts, cases, thresholds, or weights change, increment the pack version so results remain reproducible.
9. Inspect raw evidence before recruitment. Scores summarize evidence; they do not replace it.

## Security model

Role packs are untrusted data, not executable plugins.

The validator rejects unknown fields, unsafe/path-like IDs and model patterns, non-JSON files, lexical or symlink traversal outside an allowed pack root, unsupported evaluator types, invalid references, duplicate IDs, excessive counts, oversized prompts, invalid types, and malformed semantic versions. `loadRolePack` defaults its allowed root to the current working directory; pass a narrower explicit `root` in production. Evaluation caps candidates, cases, trials, concurrency, regex length, and retained response length.

Regex flags are limited to `i`, `m`, `s`, and `u`. Backreferences, lookarounds, and quantified groups are rejected to block common catastrophic-backtracking constructions. Regex is still best kept simple and anchored.

The engine never uses `eval`, `Function`, shell commands, dynamic imports, template execution, network APIs, or state writes. A pack cannot grant itself permissions: the `permissions` object is descriptive, and the host remains responsible for authentication, authorization, sandboxing, secrets, data classification, approvals, and provider policy.

Model output is also untrusted. Consumers should render it as text, keep evidence separate from control messages, and never execute returned code or tool instructions automatically. `valid_json` proves syntax only; downstream code must validate any application-specific JSON schema before acting.

## Deliberate non-goals

This initial slice does not:

- Discover models or fetch prices
- Automatically recruit, update, or export a persona
- Enforce runtime permissions
- Persist results or publish packs
- Run an LLM-as-judge evaluator
- Claim statistical certification

Those are integration and product concerns. Keeping this boundary narrow makes role packs portable, testable, and safe to open-source independently.
