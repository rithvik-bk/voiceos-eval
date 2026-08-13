#!/usr/bin/env node
// label.js — turn real voiceos.db logs into a REAL, measured accuracy number.
//
//   node label.js --db "<voiceos.db>"     # 1) extract actionable turns -> labels.todo.json
//   (you edit labels.todo.json: set correct_tool for each row — the human answer key)
//   node label.js --build                  # 2) score the model's real calls vs your labels
//
// This is the honest core of an eval: a human decides the correct answer, then we
// measure how often the model's LOGGED call matched. The number you get is a real
// measurement of VoiceOS's behavior on your real logs (small n — stated, not hidden).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const TODO = path.join(__dirname, 'labels.todo.json');

// chitchat / info turns that aren't a routing test — excluded from the answer key
const SKIP = /^(hello|hi|hey there|thanks|thank you|like i said|transcription by|what can voiceos|ok|okay|yes|no)\b/i;

if (args.includes('--db') || (!args.includes('--build') && opt('--db', null))) {
  const db = opt('--db', null);
  const q = `select t.id as turn_id, t.user_message as um, c.tool_name, c.sequence
             from agent_tool_calls c join agent_turns t on c.turn_id = t.id
             where t.user_message is not null and t.user_message <> ''
             order by t.created_at, c.sequence`;
  const rows = JSON.parse(execFileSync('sqlite3', ['-json', db, q], { encoding: 'utf8' }) || '[]');
  const turns = new Map();
  for (const r of rows) {
    if (!turns.has(r.turn_id)) turns.set(r.turn_id, { um: r.um, called: [] });
    turns.get(r.turn_id).called.push(r.tool_name.replace(/^custom_integration:[^:]+:/, ''));
  }
  const rowsOut = [];
  for (const [id, t] of turns) {
    if (SKIP.test(t.um.trim())) continue;
    rowsOut.push({
      id, utterance: t.um.trim().slice(0, 120),
      model_called: t.called,                       // what actually fired (may be >1 = fan-out)
      correct_tool: '',                             // <-- YOU fill: the ONE tool that should fire (or "NONE")
      note: ''
    });
  }
  fs.writeFileSync(TODO, JSON.stringify({
    instructions: "For each row set correct_tool to the ONE tool that SHOULD have fired (use 'NONE' if no tool should). model_called shows what actually fired; 2+ entries = the model over-called (fan-out). Judge independently, then run: node label.js --build",
    labeled: rowsOut.length, rows: rowsOut
  }, null, 2));
  console.log(`\nWrote ${rowsOut.length} actionable turns to labels.todo.json`);
  console.log(`Fill in "correct_tool" for each, then: node label.js --build\n`);
  process.exit(0);
}

if (args.includes('--build')) {
  const data = JSON.parse(fs.readFileSync(TODO, 'utf8'));
  const done = data.rows.filter(r => r.correct_tool && r.correct_tool.trim());
  if (!done.length) { console.error('No rows labeled yet — set correct_tool in labels.todo.json first.'); process.exit(1); }
  let toolOK = 0, fanout = 0;
  const misses = [];
  for (const r of done) {
    const want = r.correct_tool.trim();
    const called = r.model_called;
    // right iff the model fired EXACTLY the one correct tool (extras = over-call = wrong)
    const exact = called.length === 1 && called[0].toLowerCase() === want.toLowerCase();
    const wantNone = want.toUpperCase() === 'NONE';
    const ok = wantNone ? called.length === 0 : exact;
    if (ok) toolOK++;
    else { misses.push(r); if (called.length > 1) fanout++; }
  }
  const n = done.length, acc = (toolOK / n * 100).toFixed(1);
  const line = '─'.repeat(60);
  console.log(`\nvoiceos-eval — REAL tool-routing accuracy on your logs`);
  console.log(`source: VoiceOS's own logged calls (agent_tool_calls) · human-labeled answer key`);
  console.log(line);
  console.log(`  Labeled turns:          ${n}`);
  console.log(`  Correct tool routing:   ${toolOK}/${n}  =  ${acc}%`);
  console.log(`  Fan-out over-calls:     ${fanout}`);
  console.log(line);
  for (const r of misses) console.log(`  ✗ "${r.utterance.slice(0,46)}"  wanted ${r.correct_tool}, fired [${r.model_called.join(', ')}]`);
  console.log(`\n  (n=${n}, my own logs — a real measurement, not a projection. Scales the`);
  console.log(`   moment you point it at a larger labeled slice of production traffic.)\n`);
  process.exit(0);
}

console.error('usage: node label.js --db "<voiceos.db>"   |   node label.js --build');
process.exit(1);
