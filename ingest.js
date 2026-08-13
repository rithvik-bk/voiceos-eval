#!/usr/bin/env node
// ingest.js — turn a real voiceos.db into something the eval scores, and audit live
// logs for danger with NO answer key.
//
//   node ingest.js --db voiceos.db                 > traces.json   # export logged calls -> traces
//   node ingest.js --db voiceos.db --audit --catalog <manifest>    # flag risky mismatches, no gold needed
//   node ingest.js --json rows.json ...                            # if you exported rows yourself
//
// Reads the confirmed schema: agent_tool_calls(id, session_id, user_message,
// tool_name, arguments[JSON], status, result, created_at). arguments is a JSON string.
//
// The DB gives what the model DID (predictions), not ground truth. So:
//   - as traces: pair with a gold answer key (gen.js / curated) and run.js scores it.
//   - as --audit: run the pre-fire safety gate over real high-risk calls — this needs
//     no answer key, because it checks each call's args against the user's own words.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { verify, highRiskFromCatalog } = require('./verify.js');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const AUDIT = args.includes('--audit');
const dbPath = opt('--db', null);
const jsonPath = opt('--json', null);
const catalogF = opt('--catalog', 'catalog.json');

function loadRows() {
  if (jsonPath) return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  if (dbPath) {
    const out = execFileSync('sqlite3', ['-json', dbPath,
      'select id, user_message, tool_name, arguments, status from agent_tool_calls order by created_at'],
      { encoding: 'utf8' });
    return out.trim() ? JSON.parse(out) : [];
  }
  throw new Error('give --db <voiceos.db> or --json <rows.json>');
}

function parseArgs(a) { try { return JSON.parse(a); } catch { return {}; } }

const rows = loadRows();

if (!AUDIT) {
  // export -> traces.json format keyed by row id
  const traces = {};
  for (const r of rows) traces[r.id] = { tool: r.tool_name, arguments: parseArgs(r.arguments) };
  process.stdout.write(JSON.stringify({
    _comment: `exported from voiceos.db agent_tool_calls (${rows.length} rows)`,
    source: dbPath || jsonPath, traces
  }, null, 2) + '\n');
  process.exit(0);
}

// --audit: safety-gate every high-risk logged call, no answer key required
const raw = JSON.parse(fs.readFileSync(path.isAbsolute(catalogF) ? catalogF : path.join(__dirname, catalogF), 'utf8'));
const HIGH_RISK = highRiskFromCatalog(raw);
let checked = 0, blocked = 0;
console.log(`\nvoiceos-eval AUDIT — ${rows.length} logged calls, high-risk tools: [${[...HIGH_RISK].join(', ')}]`);
console.log('─'.repeat(60));
for (const r of rows) {
  if (!HIGH_RISK.has(r.tool_name)) continue;
  checked++;
  const v = verify(r.user_message, r.tool_name, parseArgs(r.arguments), HIGH_RISK);
  if (!v.ok) {
    blocked++;
    console.log(`  ✋ BLOCK  ${r.id}  "${r.user_message}"`);
    console.log(`           fired ${r.tool_name}(${r.arguments})`);
    console.log(`           ${v.reason}`);
  } else {
    console.log(`  ✓ ok     ${r.id}  "${r.user_message}" -> ${r.tool_name}`);
  }
}
console.log('─'.repeat(60));
console.log(`  ${checked} high-risk calls audited · ${blocked} would have been BLOCKED before firing\n`);
