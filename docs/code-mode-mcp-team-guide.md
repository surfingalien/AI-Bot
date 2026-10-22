# Code Mode MCP: Team Guide

A concept explainer and implementation plan. Part 1 is for explaining the idea. Part 2 is for building it.

---

## Part 1: The concept

### 1. The problem with normal MCP

With standard MCP, the model is given **every tool definition up front** and calls tools **one at a time**.

Two things go wrong as you add servers:

1. **Context bloat.** 5 servers x 30 tools means tens of thousands of tokens of tool descriptions in every request, before the user has said anything.
2. **Round-trip bloat.** Every intermediate result passes back through the model.
   *"Find the 5 newest repos and count their open issues"* becomes about 6 sequential tool calls. Each call's full output sits in context, and the model is the "glue" between steps.

### 2. The idea: let the model write code, not tool calls

> **Code Mode:** instead of calling tools directly, the model writes a small program that calls them. The program runs in a sandbox. Only the final answer comes back.

An analogy for the team: a manager (the model) can either walk to the warehouse for each item one at a time and carry each item back to the office, or hand a clerk a **written pick-list** and get back one finished box.

### 3. Before and after

**Before (direct tool calls):**
```
Model -> list_repos()            -> 200 repos dumped into context
Model -> get_issues(repo1)       -> result into context
Model -> get_issues(repo2)       -> result into context
... (x5)
Model -> answer
```

**After (Code Mode):**
```
Model -> search_tools("repos issues")     -> 2 short signatures
Model -> execute_code(`
  const repos = await servers.github.list_repos({sort:"updated"});
  const out = [];
  for (const r of repos.slice(0,5))
    out.push({repo:r.name, open:(await servers.github.get_issues({repo:r.name,state:"open"})).length});
  return out;
`)                                         -> small JSON result
Model -> answer
```

The 200-repo list never enters the model's context. It stays inside the sandbox.

### 4. Why it works

| Benefit | Why |
|---|---|
| **Fewer tokens** | Tool definitions load on demand (`search_tools`). Big intermediate data stays in the sandbox. |
| **Fewer model turns** | Loops, filters, joins, and retries happen in code. |
| **Better accuracy** | Models are very good at writing code and weaker at long chains of JSON tool calls. |
| **Composability** | The model can combine tools from different servers in one program. |
| **Privacy option** | Sensitive data can be processed and summarized in the sandbox without the model seeing it raw. |

### 5. Architecture

```
          ┌────────────┐   search_tools / execute_code   ┌─────────────────────┐
 Model ──>│ MCP client │───────────────────────────────> │  Code Mode Gateway  │
          └────────────┘                                  │  (our MCP server)   │
                                                          └─────────┬───────────┘
                                                      runs code in  │  proxies calls
                                                  ┌─────────────────▼──┐   ┌──────────────┐
                                                  │  Sandbox (no net,  │──>│ Upstream MCP │
                                                  │  no FS, limits)    │   │ servers      │
                                                  └────────────────────┘   └──────────────┘
```

Key points to emphasize:
- The model sees **2-3 tools only**: `search_tools`, `execute_code` (and optionally `read_api`).
- Real credentials live in the **gateway**, never in the sandbox or the model.
- The sandbox can reach upstream tools **only through the gateway**, which enforces policy.

### 6. Where "constrained decoding" fits (common confusion)

- **Constrained decoding** is a *technique*: the decoder is restricted by a grammar or schema so output is always valid (for example, structured outputs, Outlines, XGrammar).
- It is **not required** for Code Mode. Modern models write valid code already.
- **Optional use:** constrain generated code to the allowed API surface, or validate with a TypeScript typecheck before running.
- Do not call it a "CDM model". It is a decoding method that works with any model.

### 7. When to use it (and when not to)

**Use Code Mode when:**
- there are many tools or many servers,
- tasks need loops, filtering, aggregation, or multi-step workflows,
- tool outputs are large.

**Skip it when:**
- there are only 1-5 tools and the tasks are single-step,
- you cannot run a sandbox safely,
- the actions are high-stakes and need a human to approve each call (you can still use it, with an approval gate).

### 8. Skill vs agent vs MCP server

| Piece | Role here |
|---|---|
| **MCP server (gateway)** | **The core.** It provides execution, sandboxing, and policy. |
| **Skill** | Optional guidance text: "search first, batch in code, return minimal output". |
| **Agent** | Not required. Code Mode improves how any single agent calls tools. |

### 9. Risks to discuss honestly

- **Sandbox escape** is the biggest risk. Use real isolation (Deno permissions, V8 isolate, container). Never Node's `vm`.
- **Prompt injection** via tool results. Treat all tool output as untrusted data.
- **Runaway code** (infinite loops, call storms). Use timeouts and call budgets.
- **Over-powerful tools.** The code can call anything allowlisted, so scope the allowlist.
- **Debuggability.** Log every code run and every upstream call.

---

## Part 2: Implementation plan

### Roles and ownership

| Workstream | Owner skills | Deliverable |
|---|---|---|
| Gateway + MCP wiring | Backend / TS | `server.ts`, `upstream.ts` |
| Codegen (schemas -> TS stubs) | Backend | `codegen.ts`, `search_tools` index |
| Sandbox + RPC bridge | Security-minded backend | `sandbox.ts` + escape tests |
| Policy and observability | Platform / security | allowlist, redaction, audit log |
| Evaluation | Anyone | benchmark tasks, token comparison |

### Phases

**Phase 0: Spike (1-2 days)**
- Wrap **one** upstream MCP server.
- Hard-code a Deno subprocess sandbox.
- Success: one demo task runs end-to-end through `execute_code`.

**Phase 1: Core (about 1 week)**
1. Upstream connections (`@modelcontextprotocol/sdk` client, stdio first).
2. Codegen: `json-schema-to-typescript` produces a typed signature per tool.
3. `search_tools`: keyword search over the index, returning signatures.
4. `execute_code`: sandbox with an RPC bridge.
   - Sandbox runs with `--allow-none`.
   - Calls go over stdin/stdout as JSON lines.
   - Gateway checks the allowlist and call budget, then calls the upstream.
5. Limits: 30 s timeout, 128 MB memory, 50 calls, 10 KB output cap.

**Phase 2: Hardening (about 1 week)**
- Per-tool policy: read-only by default, explicit opt-in for writes.
- Redact secrets and PII from results.
- Structured audit log (who, code, calls, duration).
- Typecheck the generated code against the stubs before running.
- Adversarial tests (see below).

**Phase 3: Quality and rollout**
- Embedding-based `search_tools` once there are 100+ tools.
- A skill with usage guidance.
- Optional `save_function` for reusable helpers.
- Roll out to a pilot group, then everyone.

### Reference interface

```ts
// Tool 1
search_tools({ query: string, limit?: number })
  -> TypeScript signatures + descriptions

// Tool 2
execute_code({ code: string })
  -> { result: any, logs: string[], calls: number, truncated: boolean }

// In-sandbox API generated from upstream tools
await servers.<server>.<tool>(input)
```

### Sandbox rules (non-negotiable)

1. No network, filesystem, env, or subprocess access from sandbox code.
2. All upstream access goes through the gateway RPC bridge.
3. Secrets exist only in the gateway process.
4. Hard limits on time, memory, call count, and output size.
5. Every run is logged.

### Test plan

**Functional**
- Single-tool task, multi-tool task, and a loop across 20 items.
- Error propagation: an upstream error surfaces as a catchable exception.
- Large output gets truncated, with a flag.

**Security (must pass before any rollout)**
- `fetch("https://example.com")` fails.
- Reading files or env vars fails.
- `while(true){}` is killed at the timeout.
- Allocating a huge array hits the memory cap.
- Calling a non-allowlisted tool is denied.
- A prompt-injection string in a tool result cannot change the policy.

**Evaluation (to prove the value)**
Pick 10 representative tasks. Run each with direct MCP and with Code Mode. Record:
- total tokens,
- number of model turns,
- success rate,
- wall-clock time.

### Demo script (5 minutes)

1. Show a direct-MCP run of "newest 5 repos + open issue counts". Point out the number of tool calls and the token total.
2. Show the same task through Code Mode: one `search_tools`, one `execute_code`. Show the token count.
3. Show the sandbox blocking `fetch`. This builds trust quickly.
4. Show the audit log.

### FAQ for the team

**Is the model running arbitrary code on our machines?**
Only inside the sandbox, with no network, no filesystem, and tight limits. Upstream access goes through the gateway's allowlist.

**Doesn't this just move the risk?**
It concentrates it in one auditable place (the gateway) instead of spreading it across every tool call.

**Do we lose human approval?**
No. Add an approval gate in the gateway for write or destructive tools.

**Does it work with any model?**
Any model that writes good TypeScript or Python. Stronger coding models give better results.

**Why not just fewer tools?**
Trimming tools helps, but it limits capability. Code Mode keeps the full tool set available on demand.

### Definition of done

- [ ] Gateway runs and is registered as one MCP server
- [ ] Sandbox passes every security test
- [ ] Allowlist and audit log are in place
- [ ] Benchmark shows a measurable token and turn reduction
- [ ] Docs and the usage skill are published
