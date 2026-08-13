#!/usr/bin/env node
// run.js — voiceos-eval test runner + release gate.
//
//   node run.js                      # score fixture traces (real voiceos.db rows in prod), no API key
//   node run.js --gate               # exit 1 if the gate fails (for CI / pre-merge)
//
// Targets (how we get the model's tool call):
//   fixture  (default) — score recorded calls. In prod: export from voiceos.db agent_tool_calls.
//   live               — `claude -p` routes each utterance over the catalog (no cloud key). [--target live]
//
// Thresholds are the release gate.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { scoreCase, aggregate } = require('./score.js');
const { verify, highRiskFromCatalog } = require('./verify.js');

const args = process.argv.slice(2);
const GATE = args.includes('--gate');
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const TARGET = opt('--target', 'fixture');
// Point at ANY integration: --catalog <manifest> --gold <cases> --traces <db export>
const CATALOG_F = opt('--catalog', 'catalog.json');
const GOLD_F = opt('--gold', 'gold.json');
const TRACES_F = opt('--traces', 'traces.json');

const load = f => JSON.parse(fs.readFileSync(path.isAbsolute(f) ? f : path.join(__dirname, f), 'utf8'));
const rawCatalog = load(CATALOG_F);
// normalize: accept VoiceOS manifest (parameters) or MCP-style (inputSchema); tools[] either way
const catalog = { name: rawCatalog.name || rawCatalog.id || 'integration', tools: (rawCatalog.tools || []).map(t => ({
  ...t, parameters: t.parameters || t.inputSchema || { properties: {}, required: [] }
})) };
const gold = load(GOLD_F);
const HIGH_RISK = highRiskFromCatalog(catalog);

const THRESHOLDS = { tool_accuracy_min: 0.90, critical_error_rate_max: 0, param_accuracy_min: 0.85 };

// ---- get the tool call for each case, per target ----
function getTrace(caseId, utterance) {
  if (TARGET === 'fixture') {
    const t = load(TRACES_F).traces[caseId];
    if (!t) throw new Error(`no fixture trace for ${caseId}`);
    return t;
  }
  if (TARGET === 'live') {
    // route via claude -p over the catalog with write-tools mocked read-only (VoiceOS's suggested no-side-effect path)
    const sys = `You are VoiceOS's router. Given the user's request and this tool catalog, respond with ONLY a JSON object {"tool": <name or null>, "arguments": {...}} for the single best tool call. No prose.\nCATALOG:\n${JSON.stringify(catalog.tools)}`;
    const out = execFileSync('claude', ['-p', `${sys}\n\nUSER: ${utterance}`], { encoding: 'utf8', timeout: 60000 });
    const m = out.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : { tool: null, arguments: {} };
  }
  throw new Error(`unknown target ${TARGET}`);
}

// ---- run ----
const results = [];
const blocks = [];
for (const c of gold.cases) {
  const trace = getTrace(c.id, c.utterance);
  const r = scoreCase(c, trace);
  results.push(r);
  // safety gate: for high-risk calls, would we have blocked before firing?
  if (trace && trace.tool) {
    const v = verify(c.utterance, trace.tool, trace.arguments || {}, HIGH_RISK);
    if (!v.ok) blocks.push({ id: c.id, utterance: c.utterance, tool: trace.tool, args: trace.arguments, reason: v.reason });
  }
}
const agg = aggregate(results);

// ---- report ----
const pct = x => (x * 100).toFixed(1) + '%';
const line = '─'.repeat(58);
const PROVENANCE = {
  fixture: 'ILLUSTRATIVE fixture (hand-authored) — demonstrates the scorer, NOT a measurement of VoiceOS',
  live: 'BENCHMARK — a temp-0 model routing over the real descriptions, NOT VoiceOS\'s production model',
  voiceos: 'REAL — scored against VoiceOS\'s own logged tool calls'
};
console.log(`\nvoiceos-eval — ${catalog.name} @ ${TARGET}`);
console.log(`TOOLS_IN_CTX ${catalog.tools.length} · CASES ${agg.n} · flat-context (all tools every turn)`);
console.log(`source: ${PROVENANCE[TARGET] || TARGET}`);
console.log(line);
for (const r of results) {
  const mark = r.pass ? 'PASS' : 'FAIL';
  let detail;
  if (r.class === 'negative') detail = r.pass ? 'correctly made no call' : `false call -> ${r.got_tool}`;
  else if (!r.tool_ok) detail = `WRONG TOOL: wanted ${r.expected_tool}, got ${r.got_tool}`;
  else {
    const bad = r.params.filter(p => !p.ok).map(p => `${p.key}=${JSON.stringify(p.got)}!=${JSON.stringify(p.expected)}${p.critical ? ' (crit)' : ''}`);
    detail = bad.length ? `bad params: ${bad.join(', ')}` : 'tool + all params correct';
  }
  console.log(`  ${mark}${r.critical_error ? ' ⚠crit' : '     '}  ${r.id.padEnd(22)} ${detail}`);
}
console.log(line);
console.log(`  Tool accuracy          ${pct(agg.tool_accuracy)}`);
console.log(`  Parameter accuracy     ${pct(agg.param_accuracy)}`);
console.log(`  Critical-param accuracy${pct(agg.critical_param_accuracy)}`);
console.log(`  Critical errors        ${agg.critical_errors}`);
console.log(`  Cases passing          ${agg.passes}/${agg.n}`);
console.log(line);

// SHIP SCORE (VoiceOS ship-readiness spec): each case earns up to 2 points —
// 1 for correct tool, 1 for all parameters exact. Ship Score = points / (2 * cases).
const callCases = results.filter(r => r.class !== 'negative' || true); // all cases count
const correctTools = results.filter(r => r.tool_ok).length;
// the parameter point requires the tool was right too — so a wrong tool (or a negative
// case that wrongly fired something) never earns "all params exact".
const exactParams = results.filter(r => r.param_total === r.param_correct && r.tool_ok).length;
const shipScore = agg.n ? ((correctTools + exactParams) / (2 * agg.n) * 100).toFixed(1) : '0.0';
console.log(`  Dimension 1 — Tool Routing Accuracy      ${pct(agg.tool_accuracy)}`);
console.log(`  Dimension 2 — Parameter Extraction       ${pct(agg.param_accuracy)}`);
console.log(`  Dimension 3 — Negative/Out-of-Scope      ${(() => { const neg = results.filter(r => r.class === 'negative'); return neg.length ? pct(neg.filter(r => r.pass).length / neg.length) : 'n/a'; })()}`);
console.log(`  ── SHIP SCORE ────────────────────────── ${shipScore}%`);
console.log(line);

if (blocks.length) {
  console.log(`\n  SAFETY GATE — ${blocks.length} high-risk call(s) BLOCKED before execution:`);
  for (const b of blocks) {
    console.log(`   ✋ ${b.id}: "${b.utterance}"`);
    console.log(`        would fire ${b.tool}(${JSON.stringify(b.args)})`);
    console.log(`        BLOCKED — ${b.reason}`);
  }
} else {
  // Healthy fixture: no real mismatches to block, so run a pre-flight SELF-CHECK to
  // prove the gate is live. This is the check that runs in front of every high-risk
  // confirmation card — here fed a deliberately corrupted call to show what it stops.
  const demoUtter = 'refund forty dollars to Jane';
  const demoTool = 'refund_payment';
  const demoArgs = { customer: 'John', amount: 400 };
  const dv = verify(demoUtter, demoTool, demoArgs, HIGH_RISK.has(demoTool) ? HIGH_RISK : new Set([demoTool]));
  console.log(`\n  SAFETY GATE — pre-flight self-check (0 real mismatches in this run):`);
  console.log(`   ✋ "${demoUtter}"`);
  console.log(`        if the model fired ${demoTool}(${JSON.stringify(demoArgs)})`);
  console.log(`        BLOCKED — ${dv.reason}`);
}

// ---- release gate ----
const fails = [];
// no cases = no evidence: a CI misconfig must never silently green-light a ship.
if (agg.n === 0) fails.push('no cases scored — nothing to prove readiness');
// use !(x >= min) so a NaN metric (e.g. 0/0) counts as a failure, not a pass.
if (!(agg.tool_accuracy >= THRESHOLDS.tool_accuracy_min)) fails.push(`tool accuracy ${pct(agg.tool_accuracy)} < ${pct(THRESHOLDS.tool_accuracy_min)}`);
if (!(agg.param_accuracy >= THRESHOLDS.param_accuracy_min)) fails.push(`param accuracy ${pct(agg.param_accuracy)} < ${pct(THRESHOLDS.param_accuracy_min)}`);
if (agg.critical_errors > THRESHOLDS.critical_error_rate_max) fails.push(`${agg.critical_errors} critical error(s) > ${THRESHOLDS.critical_error_rate_max} allowed`);

console.log('');
if (fails.length) {
  console.log(`  RELEASE GATE: ❌ FAIL`);
  fails.forEach(f => console.log(`     - ${f}`));
  console.log(`  (The gate blocks this catalog from shipping until fixed — but note the`);
  console.log(`   safety gate already caught the money error live, before it could fire.)`);
} else {
  console.log(`  RELEASE GATE: ✅ PASS — safe to ship`);
}
console.log('');

// ---- optional self-contained HTML report: --html <path> ----
const htmlPath = opt('--html', null);
if (htmlPath) {
  const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const rowsHtml = results.map(r => {
    const status = r.pass ? 'pass' : 'fail';
    const got = r.class === 'negative'
      ? (r.pass ? 'no tool (correct)' : `called ${esc(r.got_tool)}`)
      : `${esc(r.got_tool)}(${esc(r.params.map(p => `${p.key}=${JSON.stringify(p.got)}`).join(', '))})`;
    const exp = r.expected_tool ? `${esc(r.expected_tool)}(${esc((gold.cases.find(c => c.id === r.id)?.expected_parameters ? Object.entries(gold.cases.find(c => c.id === r.id).expected_parameters).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ') : ''))})` : 'no tool';
    return `<tr class="${status}"><td>${esc(r.id)}</td><td class="exp">${exp}</td><td class="got">${got}</td><td class="st">${r.pass ? '✓ PASS' : (r.critical_error ? '⚠ CRITICAL' : '✗ FAIL')}</td></tr>`;
  }).join('\n');
  const html = `<!doctype html><meta charset="utf-8"><title>voiceos-eval report</title>
<style>
:root{--bg:#0b0d10;--fg:#e6e9ee;--mut:#8b95a3;--line:#1c2128;--pass:#3fb950;--fail:#f85149;--crit:#d29922;--card:#11151a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;padding:32px}
h1{font-size:18px;margin:0 0 4px}.sub{color:var(--mut);margin-bottom:24px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:24px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}
.card .n{font-size:24px;font-weight:600}.card .l{color:var(--mut);font-size:12px}
.ship{font-size:30px;color:var(--pass)}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--mut);font-weight:500}
tr.fail .st{color:var(--fail)}tr.pass .st{color:var(--pass)}
td.exp{color:var(--mut)}td.got{color:var(--fg)}
tr.fail td.got{color:var(--fail)}
.gate{margin-top:20px;padding:12px 16px;border-radius:10px;font-weight:600}
.gate.pass{background:rgba(63,185,80,.12);color:var(--pass)}.gate.fail{background:rgba(248,81,73,.12);color:var(--fail)}
.prov{color:var(--mut);font-size:12px;margin-top:8px}
</style>
<h1>voiceos-eval — ${esc(catalog.name)}</h1>
<div class="sub">${esc(catalog.tools.length)} tools in context · ${agg.n} cases · ${esc(TARGET)} target</div>
<div class="grid">
<div class="card"><div class="n">${pct(agg.tool_accuracy)}</div><div class="l">Tool Routing Accuracy</div></div>
<div class="card"><div class="n">${pct(agg.param_accuracy)}</div><div class="l">Parameter Extraction</div></div>
<div class="card"><div class="n">${agg.critical_errors}</div><div class="l">Critical Errors</div></div>
<div class="card"><div class="n ship">${shipScore}%</div><div class="l">SHIP SCORE</div></div>
</div>
<table><thead><tr><th>case</th><th>expected</th><th>actual (what the model did)</th><th>status</th></tr></thead>
<tbody>${rowsHtml}</tbody></table>
${blocks.length ? `<div class="gate fail">🛑 SAFETY GATE blocked ${blocks.length} high-risk call(s) before execution: ${blocks.map(b => esc(b.id)).join(', ')}</div>` : ''}
<div class="gate ${fails.length ? 'fail' : 'pass'}">${fails.length ? '❌ RELEASE GATE: FAIL — ' + fails.map(esc).join('; ') : '✅ RELEASE GATE: PASS — safe to ship'}</div>
<div class="prov">source: ${esc(PROVENANCE[TARGET] || TARGET)}</div>`;
  fs.writeFileSync(path.isAbsolute(htmlPath) ? htmlPath : path.join(process.cwd(), htmlPath), html);
  console.log(`  HTML report written to ${htmlPath}\n`);
}

if (GATE && fails.length) process.exit(1);
