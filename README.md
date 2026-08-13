# voiceos-eval

**A tool-calling test runner and pre-execution safety gate.** It scores whether a voice assistant called the *right tool* with the *right parameters*, and blocks wrong destructive calls before they fire.

## 30-second demo

Works on a fresh clone with zero setup — no `npm install`, no API key. Pure Node.

```bash
git clone <repo> && cd voiceos-eval
node run.js          # scorecard + release gate on the bundled example
```

```
voiceos-eval — voiceos_first_party_subset @ fixture
TOOLS_IN_CTX 8 · CASES 11 · flat-context (all tools every turn)
──────────────────────────────────────────────────────────
  PASS   msg-03-collision-3      tool + all params correct
  PASS   music-01-liked          tool + all params correct
  PASS   cal-01-duration         tool + all params correct
  PASS   pay-03-refund           tool + all params correct
  …
──────────────────────────────────────────────────────────
  Tool accuracy           100.0%
  Parameter accuracy      100.0%
  Critical-param accuracy 100.0%
  Critical errors         0
  ── SHIP SCORE ────────── 100.0%
──────────────────────────────────────────────────────────

  SAFETY GATE — pre-flight self-check (0 real mismatches in this run):
   ✋ "refund forty dollars to Jane"
        if the model fired refund_payment({"customer":"John","amount":400})
        BLOCKED — amount: you said $40, the call would send $400  |  recipient: you said "Jane", the call targets "John"

  RELEASE GATE: ✅ PASS — safe to ship
```

The bundled example is a healthy integration, so it ships. To watch the runner catch real failures — a lookalike-tool collision, a mis-extracted parameter, and a wrong-money refund — run the opt-in failing fixture: `node run.js --traces traces.buggy.json`.

## The problem

A voice assistant puts many tool descriptions in front of the model at once, and two failures grow with the catalog. Lookalike tools collide, so the model picks the **wrong tool** (message vs. email; a track vs. a playlist). And values get mis-extracted, so the right tool fires with the **wrong parameters** — `$400` when the user said `$40`, or a calendar event that quietly defaults to 1 hour when the user asked for 30 minutes. Confirmation cards appear *after* the model has already chosen the tool and filled the arguments, so nothing actually checks that the choice was correct before the user taps "confirm."

## What it does

Three pillars, each usable on its own:

- **Generate** — `gen.js` auto-derives test cases from any integration manifest. It chooses the parameter values first and then builds an utterance that contains them, so every answer is correct-by-construction — no hand-authored answer key, no API key. Four categories: Happy Path, Entity & Value Disambiguation (spoken money *and* multi-word values), **Lookalike Collision** (tool-name-free utterances that pin the boundary between two tools sharing a verb — the flat-context failure mode), and Negative / Out-of-Scope.
- **Score** — the scorer deterministically compares the tool call that happened against the answer key: right tool? right parameters? It runs with **no model and no API key**, so the number is exact and reproducible.
- **Guard** — `guard()` is a pre-execution safety check that runs *between* "model chose a tool" and "action fires." For any tool the manifest flags high-risk, it re-derives the safety-critical facts from the user's own words and blocks on mismatch. Gate coverage spans the three ways a high-risk call goes wrong: the **money amount** (spoken or written — "forty dollars", "$54.94", cents-vs-dollars bugs), the **named recipient** ("email Priya" vs. a call to `all-staff`; "to Jane" vs. a call targeting John), and the **destructive target** — *which record gets destroyed* ("delete issue 5" vs. a call on issue 999, "merge PR 482" vs. PR 17, "delete report.pdf" vs. budget.xlsx). It matches across common field aliases (`amount`/`amount_cents`, `customer`/`recipient`/`to`, `issue_id`/`id`/`filename`/`pr`), and only blocks a target when the user named a *specific* one — "delete that" is never false-blocked.

## Run it

Every entrypoint, no hidden steps. All run on Node alone; the `live` and description-optimizer paths additionally shell out to a local `claude` CLI.

| command | what it does |
|---|---|
| `node run.js` | Score the bundled fixture. Prints the scorecard, the 3 ship dimensions, the Ship Score, the safety-gate self-check, and the release gate. No API key. |
| `node run.js --gate` | Same run, but **exit non-zero** if the release gate fails — drop it in CI / a pre-merge check. |
| `node run.js --target live` | Route each utterance through a local `claude` CLI over the catalog (write/destructive tools mocked read-only). Requires the `claude` CLI on `PATH`; no cloud key. |
| `node run.js --traces traces.buggy.json` | The opt-in **failing** fixture — see the runner catch a wrong tool, a mis-extracted parameter, and a wrong-money refund. Add `--gate` for a red gate + exit 1. |
| `node verify.js` | Standalone safety-gate demo — ALLOW / BLOCK on a set of money calls. |
| `node index.js` | The `guard()` library self-check + a latency print (sub-millisecond per call). |
| `node gen.js --catalog <manifest>` | Auto-generate an answer key from any manifest. `> gold.json`. Add `--llm` to naturalize phrasing via `claude -p` without changing the answers. |
| `node gate-benchmark.js` | Measured before/after for the guard: 8/8 wrong actions blocked (wrong amount, wrong recipient, wrong destructive target), 0 false blocks on 8 correct actions. |
| `bash new-tool-demo.sh` | End-to-end on a brand-new, unreviewed tool: auto-generate its cases, auto-detect its destructive tools, and block a wrong send — zero manual work. |

## Use it on your own integration

Nothing here is tied to one integration. Point the three flags at any manifest and its answer key:

```bash
# 1) generate an answer key from a brand-new manifest (no key, no hand-authoring)
node gen.js --catalog path/to/integration.json > gold.generated.json

# 2) score a real tool-call export against it, and gate on the result
node run.js --catalog path/to/integration.json \
            --gold    gold.generated.json \
            --traces  path/to/tool-call-export.json \
            --gate
```

`--catalog` accepts either a VoiceOS-style manifest (`parameters`) or an MCP-style one (`inputSchema`). The safety gate reads each manifest's own risk flags (`requires_confirmation: true` / `risk: "high"`), and falls back to a destructive-verb name heuristic when a manifest ships no flags — so any integration's dangerous tools get the pre-fire check with zero per-integration config.

## How scoring works

Scoring is **hierarchical** — right parameters never rescue a wrong tool:

1. Was a tool required at all? (negative cases catch a router that eagerly calls something on "thanks, that's all.")
2. Correct tool? A wrong tool fails the case outright, no matter how good the arguments look.
3. Required parameters correct? Numbers and dates are normalized against a fixed `reference_time` so "tomorrow at 3pm" and "forty dollars" are deterministic.
4. **Critical** parameters — money `amount`, `customer`, destructive targets — are tracked separately and weighted so an error can't hide inside a high aggregate average. One critical error fails the release gate even when overall accuracy looks healthy.

**Honesty stance.** Every run prints a provenance banner naming exactly what the number is: *illustrative* (a hand-authored fixture that demonstrates the scorer), *benchmark* (a temp-0 model routing over the real descriptions), or *real* (scored against an assistant's own logged tool calls). A demo number is never dressed up as a measurement.

## Library usage

Drop the guard straight into the agent loop, right in front of a confirmation card. It's deterministic and dependency-free, so it runs in well under a millisecond — safe to call on every high-risk action.

```js
const { guard } = require('./index.js');

// between "model chose a tool" and "show the confirmation card":
const check = guard(userMessage, toolName, args, catalog);
if (!check.ok) {
  showMismatchOnCard(check.reason);   // "amount: you said $40, the call would send $400"
} else {
  proceedToConfirmationCard();
}
```

```
mismatch -> { ok: false, reason: 'amount: you said $40, the call would send $400  |  recipient: you said "Jane", the call targets "John"' }
match    -> { ok: true,  reason: 'utterance and arguments agree' }
latency: 0.0010 ms/call over 10000 calls (deterministic, no model)
```

Pass the integration's manifest as `catalog` so the high-risk set comes from its own flags; omit it to use the built-in default set.

## File map

| file | what |
|---|---|
| `run.js` | Runner — scorecard, Ship Score, safety-gate self-check, release gate, optional `--html` report. |
| `score.js` | The hierarchical scorer + number/date normalizers. Pure functions, no deps. |
| `verify.js` | The pre-execution safety gate (re-derives money-critical facts from the utterance). |
| `index.js` | Library entry point — exports `guard()` and the scorer; `node index.js` is a latency self-check. |
| `gen.js` | Universal case generator — correct-by-construction cases from any manifest, in 3 categories. |
| `gate-benchmark.js` | Measured before/after for the guard on a labeled set of high-risk calls. |
| `new-tool-demo.sh` | The Build-Anything story: a brand-new unreviewed tool covered end-to-end in seconds. |
| `ingest.js` · `analyze-db.js` · `label.js` | Real-log path — export logged tool calls to traces, audit them for risk, and turn human labels into a measured accuracy number. |
| `catalog.json` · `gold.json` · `traces.json` | The bundled example manifest, answer key, and healthy tool-call fixture. |
| `traces.buggy.json` | Opt-in failing fixture (wrong tool + mis-extracted params + wrong-money refund). |
| `.github/workflows/eval.yml` | Runs `node run.js --gate` on every push / PR. |

## Status & limitations

- **Real vs. illustrative.** The scorer, the safety gate, and the generator are real, deterministic, and reproducible. The bundled `catalog.json` / `gold.json` / `traces.json` are an *illustrative* example (each run says so in its provenance banner). Swap in a real manifest and a real tool-call export to get a measured number.
- **Gate coverage.** The pre-execution guard re-derives and checks three safety-critical facts from the user's words: the **amount**, the **named recipient**, and the **destructive target** (which record an irreversible action hits). It's deliberately high-precision — it only blocks when the user named a specific value and the call contradicts it, so it lands **0 false blocks on the benchmark's 8 correct actions**. Facts the user didn't state (a "delete that" with no id) are passed through rather than guessed at; adding more parameter families is additive.
- **CLI dependency.** The `--target live` routing path and the description optimizer shell out to a local `claude` CLI. Everything else — scoring, the gate, generation, the benchmarks — runs on Node alone with no key.

MIT licensed. Built by Rithvik Burki.
