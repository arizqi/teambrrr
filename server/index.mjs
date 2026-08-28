#!/usr/bin/env node
// MCP adapter over room-core. Thin on purpose: every behaviour lives in
// ../core/room.mjs so Codex, hermes and this server share one implementation.
// This path is registered in .mcp.json / ~/.codex/config.toml — keep it stable.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createRoom } from '../core/room.mjs';
import { exportToHermes } from '../adapters/hermes/export.mjs';

const room = createRoom({
  projectDir: process.env.PERSONA_RECRUITER_CWD || process.cwd(),
  host: process.env.ROOM_HOST || 'claude-code'
});

const out = (r) => ({ content: [{ type: 'text', text: r.text }], ...(r.ok === false ? { isError: true } : {}) });

const server = new McpServer({ name: 'teambrrr', version: '0.1.0' });

server.registerTool('recruit', {
  title: 'Recruit an agent into the room',
  description: 'Create a named recruit backed by an OpenRouter model. Validates the model id against the OpenRouter catalog.',
  inputSchema: {
    name: z.string().describe('lowercase handle, 2-24 chars: ^[a-z0-9_-]{2,24}$'),
    model: z.string().describe(
      'OpenRouter model id, e.g. "openai/gpt-4o-mini", or a local one: "local/ollama/<model>" / "local/llama-server/<model>"'
    ),
    system_prompt: z.string().describe('the persona: who they are and how they should think'),
    tags: z.array(z.string()).optional().describe('topic tags, e.g. ["security","rust"]'),
    params: z.record(z.any()).optional().describe('extra completion params (temperature, max_tokens, ...)'),
    fallback_model: z.string().optional().describe(
      'model to retry on when the primary is rate limited or erroring. For a local recruit this is also what runs ' +
      'when their server is down — omit it and calls report the server-down message instead of going remote.'
    ),
    briefing: z.string().optional().describe(
      'ONBOARDING BRIEF, 10-20 lines, written by YOU from everything you know that they cannot see: ' +
      'the project and its goal, where it stands now, the decisions already taken, a glossary of local ' +
      'codenames, and what this role is expected to do. It is injected into every call. Omit it and they start cold.'
    ),
    watch: z.boolean().optional().describe(
      'when true, this recruit reviews each of your turns at Stop and may leave a comment; costs one call per turn'
    )
  }
}, async (args) => out(await room.recruit(args)));

server.registerTool('ask', {
  title: 'Ask recruit(s) in the room',
  description: 'Send a message to one recruit (name) or several in parallel (names). Recruits receive the shared channel digest plus their own history.',
  inputSchema: {
    name: z.string().optional().describe('single recruit handle'),
    names: z.array(z.string()).optional().describe('several recruit handles, asked in parallel'),
    message: z.string().optional().describe('the message, verbatim, with @mentions stripped'),
    per: z.record(z.string()).optional().describe('per-recruit message overrides, {name: message} — use when each person is asked something different')
  }
}, async (args) => out(await room.ask(args)));

server.registerTool('discuss', {
  title: 'Have recruits discuss a topic with each other',
  description:
    'Round-robin discussion between two or more recruits. Round 1 is each recruit\'s opening ' +
    'position; every later round hands each of them the previous round\'s replies, attributed ' +
    'by name, and asks them to push back or refine. Returns the full transcript grouped by round.',
  inputSchema: {
    names: z.array(z.string()).describe('two or more recruit handles'),
    topic: z.string().describe('what they are discussing, stated once, verbatim from the user where possible'),
    rounds: z.number().int().min(1).max(5).optional().describe('how many rounds (default 2, max 5) — each round costs one call per recruit'),
    digest: z.boolean().optional().describe('include the channel digest in round 1 (default true)')
  }
}, async (args) => out(await room.discuss(args)));

server.registerTool('audition', {
  title: 'Audition candidate models for a role',
  description:
    'Send one cheap probe to each candidate model in parallel and score the replies mechanically: ' +
    'honesty about missing context (the probe names a file that does not exist), length discipline, ' +
    'latency and cost. Returns a ranked table plus the raw replies. Recruits nobody — you pick, then call recruit. ' +
    'Pass `role` to also get 2-3 offer cards with a monthly cost projection — then ask the user to pick one. ' +
    'Pass `include_local` (or `local_only`) to discover and probe models running on this machine, which cost $0.',
  inputSchema: {
    candidates: z.array(z.object({
      model: z.string().describe('OpenRouter model id, or "local/<host>/<model>"'),
      fallback_model: z.string().optional().describe('model to retry on when this one rate limits')
    })).optional().describe('the models trying out, up to 4 probed at a time; may be omitted when local_only is set'),
    role_prompt: z.string().describe('the role they are auditioning for — becomes the probe task'),
    probe: z.string().optional().describe('override the task half of the probe; the missing-context trap is always appended'),
    role: z.string().optional().describe('the job title being hired for, e.g. "SDR" — turns the result into selectable offer cards with cost'),
    volume: z.union([
      z.enum(['advisor', 'worker', 'heavy']),
      z.object({
        per_day: z.number().optional(),
        tokens_in: z.number().optional(),
        tokens_out: z.number().optional()
      })
    ]).optional().describe('expected usage for the cost projection: a profile name (advisor=30/day, worker=300/day, heavy=1500/day) or explicit {per_day, tokens_in, tokens_out}'),
    include_local: z.boolean().optional().describe(
      'also discover models running on this machine (Ollama, llama-server) and probe them alongside the given ' +
      'candidates. They are namespaced local/<host>/<model>, cost $0, and are ranked on measured tok/s. ' +
      'A host that is not running is reported with its start command, never as an error.'
    ),
    local_only: z.boolean().optional().describe(
      'probe ONLY local models — the user said "local only". Any remote candidates passed in are dropped.'
    )
  }
}, async (args) => out(await room.audition(args)));

server.registerTool('local_models', {
  title: 'List models running on this machine',
  description:
    'Report the local model hosts (Ollama at :11434, llama-server at :8080, plus anything configured in ' +
    '<state>/config.json) with the models each one serves. A host that is not running is reported as such, ' +
    'with the command that would start it. Costs nothing and probes nothing.',
  inputSchema: {}
}, async () => out(await room.localModels()));

server.registerTool('evaluate_role', {
  title: 'Evaluate models against a versioned role pack',
  description:
    'Run repeated, role-specific cases against 1-4 candidate models. Uses deterministic evaluators, ' +
    'fatal safety criteria, consistency, latency and cost evidence; returns 2-3 offers but hires nobody. ' +
    'Pass `include_local` (or `local_only`) to evaluate models running on this machine, which cost $0.',
  inputSchema: {
    role_pack: z.string().describe('bundled role-pack id, e.g. sdr-outbound, security-reviewer, code-reviewer'),
    candidates: z.array(z.object({
      model: z.string().describe('OpenRouter model id, or "local/<host>/<model>"'),
      fallback_model: z.string().optional(),
      params: z.record(z.any()).optional()
    })).min(1).max(4).optional().describe('may be omitted when local_only is set'),
    trials: z.number().int().min(1).max(5).optional().describe('override trials per case; defaults to the pack'),
    max_parallel: z.number().int().min(1).max(4).optional(),
    offers: z.boolean().optional().describe('include selectable monthly-cost offers (default true)'),
    include_local: z.boolean().optional().describe(
      'also evaluate models discovered on this machine, namespaced local/<host>/<model> and priced at $0'
    ),
    local_only: z.boolean().optional().describe('evaluate ONLY local models — the user said "local only"')
  }
}, async (args) => out(await room.evaluateRole(args)));

server.registerTool('assign_task', {
  title: 'Assign an execution task to a recruit',
  description:
    'Create a durable task for a hired recruit. This records and assigns work; a Hermes/OpenClaw worker ' +
    'must claim and execute it under its own tool and approval policy.',
  inputSchema: {
    name: z.string().describe('recruit handle'),
    title: z.string().describe('short observable outcome'),
    input: z.any().optional().describe('structured task input; never executed by the room'),
    metadata: z.record(z.any()).optional(),
    room_id: z.string().optional(),
    task_id: z.string().optional(),
    idempotency_key: z.string().describe('stable caller-generated key; retries with the same input return the same task')
  }
}, async (args) => out(await room.assignTask(args)));

server.registerTool('tasks', {
  title: 'Inspect execution tasks',
  description: 'Get one task by id, or list tasks filtered by recruit and/or status.',
  inputSchema: {
    task_id: z.string().optional(),
    name: z.string().optional().describe('filter by recruit handle'),
    status: z.enum(['queued', 'assigned', 'running', 'awaiting_approval', 'completed', 'failed', 'canceled']).optional()
  }
}, async (args) => out(room.taskStatus(args)));

server.registerTool('task_decide', {
  title: 'Approve or reject an execution request',
  description:
    'Resolve a pending runtime approval. Approval returns the task to assigned so a worker can reclaim it; ' +
    'rejection terminates it. Runtime policy remains authoritative.',
  inputSchema: {
    task_id: z.string(),
    approval_id: z.string(),
    decision: z.enum(['approve', 'reject']),
    by: z.string().optional().describe('approver identity; default user'),
    reason: z.string().optional(),
    expected_version: z.number().int().min(1).optional()
  }
}, async (args) => out(await room.decideTask(args)));

server.registerTool('task_cancel', {
  title: 'Cancel an execution task',
  description: 'Cancel a non-terminal task idempotently. This records intent; the runtime observes the event and stops work.',
  inputSchema: {
    task_id: z.string(),
    reason: z.string().optional(),
    by: z.string().optional(),
    expected_version: z.number().int().min(1).optional(),
    idempotency_key: z.string().describe('stable caller-generated key for safe retries')
  }
}, async (args) => out(await room.cancelTask(args)));

server.registerTool('roster', {
  title: 'List the room',
  description: 'List current recruits with model, tags, call count and spend.',
  inputSchema: {}
}, async () => out(room.roster()));

server.registerTool('dismiss', {
  title: 'Dismiss a recruit',
  description: 'Archive a recruit; their persona and history move to <state>/.dismissed/.',
  inputSchema: { name: z.string() }
}, async (args) => out(room.dismiss(args)));

server.registerTool('show_persona', {
  title: "Show a recruit's system prompt",
  description:
    'Print a recruit\'s full system prompt (never truncated) with their model, fallback, tags, params, ' +
    'current revision and the list of past revisions. Pass `revision` to read a superseded version.',
  inputSchema: {
    name: z.string().describe('recruit handle'),
    revision: z.number().int().min(1).optional().describe('a past revision number; omit for the current one')
  }
}, async (args) => out(room.showPersona(args)));

server.registerTool('update_persona', {
  title: "Rewrite a recruit's persona",
  description:
    'Change a recruit\'s system prompt, tags, params, model or fallback_model. The superseded version is ' +
    'snapshotted as a numbered revision first, so nothing is lost. Their memory (history.jsonl) is untouched — ' +
    'they keep every exchange. Refuses if the recruit does not exist; it never creates one.',
  inputSchema: {
    name: z.string().describe('recruit handle'),
    system_prompt: z.string().optional().describe('the rewritten persona, in full — this replaces the old one'),
    tags: z.array(z.string()).optional(),
    params: z.record(z.any()).optional().describe('completion params (temperature, max_tokens, ...)'),
    model: z.string().optional().describe('rebind to a different OpenRouter model; validated against the catalog'),
    fallback_model: z.string().optional().describe('set the fallback model; pass "" to clear it'),
    watch: z.boolean().optional().describe('turn the Stop-hook watcher role on or off for this recruit')
  }
}, async (args) => out(await room.updatePersona(args)));

server.registerTool('brief_update', {
  title: "Rewrite a recruit's onboarding brief",
  description:
    'Replace a recruit\'s onboarding brief wholesale. The superseded copy is snapshotted to ' +
    'briefings/<n>.md, exactly like a persona revision, so nothing is lost. Use this when the user says ' +
    '"re-onboard <name>" or when the project has moved on far enough that the brief they were hired with ' +
    'is now misleading. The persona and their memory are untouched.',
  inputSchema: {
    name: z.string().describe('recruit handle'),
    briefing: z.string().describe(
      'the full replacement brief, 10-20 lines: project and goal, current state, decisions so far, ' +
      'glossary of codenames, what this role is expected to do'
    )
  }
}, async (args) => out(room.briefUpdate(args)));

server.registerTool('pin', {
  title: 'Pin standing context for the whole room',
  description:
    'Add one line of standing room context. Every recruit sees the pin board on every ask and discuss, ' +
    'after their onboarding brief and before the channel transcript. Pin decisions as they are taken ' +
    '("we ship Postgres, not Dynamo"), not narration. Budget is ~2000 chars across all pins — over it, ' +
    'the call is refused and you must unpin or shorten.',
  inputSchema: {
    text: z.string().describe('one decision or standing fact, one line, in the room\'s own words'),
    by: z.string().optional().describe('who decided it (default "chair")'),
    scope: z.enum(['global', 'project']).optional().describe('"project" writes to <project>/.room/pins.json; project pins stack on global ones')
  }
}, async (args) => out(room.pin(args)));

server.registerTool('unpin', {
  title: 'Remove a pinned line',
  description: 'Remove one pin by id. Run pins() first to see the ids.',
  inputSchema: { id: z.string().describe('the pin id from pins()') }
}, async (args) => out(room.unpin(args)));

server.registerTool('pins', {
  title: 'List the pin board',
  description: 'List every pin (global and project) with its id, scope and author, plus the budget used.',
  inputSchema: {}
}, async () => out(room.pins()));

server.registerTool('rollback_persona', {
  title: 'Restore an earlier persona revision',
  description:
    'Restore a past revision as a NEW revision. The chain is append-only: the revision you are leaving is ' +
    'kept, not overwritten, so you can roll forward again.',
  inputSchema: {
    name: z.string().describe('recruit handle'),
    revision: z.number().int().min(1).describe('the revision to restore — see show_persona')
  }
}, async (args) => out(room.rollbackPersona(args)));

server.registerTool('export_hermes', {
  title: 'Export a recruit as a hermes teammate',
  description:
    'Write a hired recruit out as a hermes-agent profile (SOUL.md, profile.yaml, config.yaml, .env) so it can ' +
    'EXECUTE — schedules, tools, approvals — under hermes\' own guardrails. The room keeps the persona and the ' +
    'correspondence; the exported teammate is pointed at that history read-only. Your OpenRouter key is never ' +
    'copied into the profile. Refuses to overwrite an existing profile. Run with dry_run first.',
  inputSchema: {
    name: z.string().describe('recruit handle to export'),
    dry_run: z.boolean().optional().describe('print the files it would write and write nothing — do this first'),
    role: z.string().optional().describe('role line for SOUL.md and the hermes roster; defaults to the recruit\'s tags'),
    hermes_home: z.string().optional().describe('override $HERMES_HOME (default ~/.company-os/hermes-home)')
  }
}, async (args) => out(exportToHermes({
  name: args.name,
  role: args.role,
  dryRun: args.dry_run,
  hermesHome: args.hermes_home,
  stateDir: room.stateDir,
  projectDir: room.projectDir
})));

await server.connect(new StdioServerTransport());
