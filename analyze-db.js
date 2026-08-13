#!/usr/bin/env node
// analyze-db.js — HONEST analysis of a real voiceos.db. Reports only what the logs
// actually prove, and explicitly labels what they cannot.
//
//   node analyze-db.js "/path/to/voiceos.db"
//
// Real schema (verified from the live db, NOT the simplified spec):
//   agent_turns(id, user_message, ...)   <- the user's words
//   agent_tool_calls(turn_id, tool_name, input_json, ...)   <- what the model did
//
// What the DB proves WITHOUT an answer key (reported as fact):
//   - redundant fan-out: one user turn that fired 2+ tools
//   - high-risk calls whose arguments disagree with the user's words (safety gate)
// What it CANNOT prove without labeling (stated, not hidden):
//   - a tool/parameter ACCURACY %: the log shows what the model DID, not what was
//     correct. A real accuracy number needs a human-labeled answer key (gold cases).

const { execFileSync } = require('child_process');
const { verify, highRiskFromCatalog } = require('./verify.js');

const db = process.argv[2];
if (!db) { console.error('usage: node analyze-db.js "/path/to/voiceos.db"'); process.exit(1); }

const q = `select t.id as turn_id, t.user_message as user_message, c.tool_name, c.input_json
           from agent_tool_calls c join agent_turns t on c.turn_id = t.id
           where t.user_message is not null and t.user_message <> ''
           order by t.created_at, c.sequence`;
const rows = JSON.parse(execFileSync('sqlite3', ['-json', db, q], { encoding: 'utf8' }) || '[]');

// group by turn
const turns = new Map();
for (const r of rows) {
  if (!turns.has(r.turn_id)) turns.set(r.turn_id, { msg: r.user_message, calls: [] });
  turns.get(r.turn_id).calls.push({ tool: r.tool_name, input: r.input_json });
}

const line = '─'.repeat(64);
console.log(`\nvoiceos-eval — HONEST analysis of real logs`);
console.log(`db: ${db}`);
console.log(`${rows.length} tool calls across ${turns.size} user turns`);
console.log(line);

// 1) redundant fan-out — provable from logs alone
const fanout = [...turns.values()].filter(t => t.calls.length > 1);
console.log(`\n[FACT — no answer key needed] redundant fan-out: ${fanout.length}/${turns.size} turns fired 2+ tools`);
for (const t of fanout.slice(0, 6))
  console.log(`   • "${t.msg.slice(0, 48)}" -> ${t.calls.map(c => c.tool.replace(/^custom_integration:[^:]+:/, '')).join(' + ')}`);

// 2) safety gate on high-risk calls — provable, no answer key
const highRisk = highRiskFromCatalog({ tools: [...new Set(rows.map(r => ({ name: r.tool_name })))] });
let checked = 0, flagged = 0;
for (const r of rows) {
  if (!highRisk.has(r.tool_name)) continue;
  checked++;
  let input = {}; try { input = JSON.parse(r.input_json || '{}'); } catch {}
  const v = verify(r.user_message, r.tool_name, input, highRisk);
  if (!v.ok) { flagged++; console.log(`\n[FACT] safety gate would flag: "${r.user_message.slice(0,40)}" -> ${r.tool_name}\n        ${v.reason}`); }
}
console.log(`\n[FACT] high-risk calls in these logs: ${checked}  ·  flagged by the gate: ${flagged}`);

// 3) the honest limit
console.log(line);
console.log(`[LIMIT — stated, not hidden] These logs show what the model DID, not what was`);
console.log(`correct. A tool/parameter ACCURACY % requires a human-labeled answer key`);
console.log(`(gold cases). That labeling is exactly what voiceos-eval turns into a repeatable`);
console.log(`gate: label once, re-run on every ship. No accuracy % is claimed from raw logs.`);
console.log('');
