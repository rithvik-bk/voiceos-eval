#!/usr/bin/env node
// gen.js — universal gold-case generator. Point it at ANY integration manifest and
// it emits test cases with a real answer key, no hand-authoring, no API key.
//
//   node gen.js --catalog <manifest.json> > gold.generated.json
//   node gen.js --catalog <manifest.json> --llm    # rephrase utterances naturally via `claude -p`
//
// Correct-by-construction: it CHOOSES the parameter values, then builds an utterance
// that contains them — so the expected answer is known-true, not guessed. (This is the
// schema-derived tier of the ground-truth hierarchy; a human still curates before use.)

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const USE_LLM = args.includes('--llm');
const catalogF = opt('--catalog', 'catalog.json');
const raw = JSON.parse(fs.readFileSync(path.isAbsolute(catalogF) ? catalogF : path.join(__dirname, catalogF), 'utf8'));
const tools = raw.tools || [];

// example values per type — used both to fill params AND to build the utterance
const SAMPLE = {
  STRING: (name) => ({ recipient: 'Sam', customer: 'Sam', to: 'Sam', title: 'Standup',
    playlist: 'Focus', track: 'Yesterday', description: 'monthly plan', body: 'the notes',
    message: 'the notes', subject: 'Q3 update', query: 'invoices', name: 'Standup',
    event: 'Standup', reminder: 'water plants' }[name] || `${name}X`),
  NUMBER: (name) => ({ amount: 25, duration_minutes: 45, limit: 5 }[name] || 3),
  BOOLEAN: () => true
};

// params that name WHO an action targets — a poor choice for a value-extraction stress
// case (you don't say "recipient is Quarterly Review"), so we prefer a content param.
const ADDRESSEE = new Set(['recipient', 'customer', 'to', 'destination']);

function props(tool) {
  const p = tool.parameters || tool.inputSchema || {};
  return { properties: p.properties || {}, required: p.required || [] };
}

function seedCase(tool) {
  const { properties, required } = props(tool);
  const expected = {};
  const phraseBits = [];
  for (const key of required) {
    const type = (properties[key]?.type || 'STRING').toUpperCase();
    const val = (SAMPLE[type] || SAMPLE.STRING)(key);
    expected[key] = val;
    phraseBits.push(`${key}=${val}`);
  }
  // literal, unambiguous utterance that names the action + the values (llm pass makes it natural)
  const utter = `${tool.name.replace(/_/g, ' ')} with ${phraseBits.join(', ') || 'no arguments'}`;
  const criticality = {};
  const isHigh = tool.requires_confirmation === true || tool.risk === 'high';
  if (isHigh) for (const k of required) if (['amount', 'customer', 'recipient'].includes(k)) criticality[k] = 'high';
  return {
    id: `${tool.name}-seed`,
    utterance: utter,
    category: 'Happy Path (Direct Intent)',
    class: isHigh ? 'dangerous' : 'direct',
    expected_action: 'CALL',
    expected_tool: tool.name,
    expected_parameters: expected,
    criticality
  };
}

// Disambiguation case: spell out a numeric value in words so we test extraction,
// not just routing (e.g. "fifty four dollars and ninety four cents" -> 54.94).
// Falls back to a multi-word STRING value when the tool has no amount param, so
// EVERY tool gets a value-extraction stress case — not just money tools.
function disambiguationCase(tool) {
  const { properties, required } = props(tool);
  const amtKey = required.find(k => /amount/i.test(k));
  if (amtKey) {
    const expected = {};
    for (const key of required) {
      const type = (properties[key]?.type || 'STRING').toUpperCase();
      expected[key] = key === amtKey ? 54.94 : (SAMPLE[type] || SAMPLE.STRING)(key);
    }
    const who = expected.customer || expected.recipient || 'Maya Weber';
    return {
      id: `${tool.name}-disambig`,
      utterance: `${tool.name.replace(/_/g, ' ')} for ${who}, fifty four dollars and ninety four cents`,
      category: 'Entity & Value Disambiguation',
      class: tool.requires_confirmation || tool.risk === 'high' ? 'dangerous' : 'param-stress',
      expected_action: 'CALL',
      expected_tool: tool.name,
      expected_parameters: expected,
      criticality: { [amtKey]: 'high' }
    };
  }
  // no amount: stress a STRING param with a two-word value the router must capture whole.
  // Prefer a content param over an addressee ("subject is Quarterly Review", not "recipient is…").
  const strKeys = required.filter(k => (properties[k]?.type || 'STRING').toUpperCase() === 'STRING');
  const strKey = strKeys.find(k => !ADDRESSEE.has(k)) || strKeys[0];
  if (!strKey) return null;
  const expected = {};
  for (const key of required) {
    const type = (properties[key]?.type || 'STRING').toUpperCase();
    expected[key] = key === strKey ? 'Quarterly Review' : (SAMPLE[type] || SAMPLE.STRING)(key);
  }
  return {
    id: `${tool.name}-disambig`,
    utterance: `${tool.name.replace(/_/g, ' ')}, ${strKey.replace(/_/g, ' ')} is Quarterly Review`,
    category: 'Entity & Value Disambiguation',
    class: 'param-stress',
    expected_action: 'CALL',
    expected_tool: tool.name,
    expected_parameters: expected,
    criticality: {}
  };
}

// Collision case: the flat-context failure mode. When two tools share a leading verb
// (send_email vs send_message, create_event vs create_reminder, delete_issue vs
// delete_file), the model must route on the DISTINGUISHING word alone. This utterance
// deliberately OMITS the tool name and uses only the discriminator, so a router that
// leans on the tool-name token in the utterance fails it. Fires for any catalog with
// lookalikes — correct-by-construction because the discriminator maps to exactly one tool.
function collisionCase(tool, siblings) {
  const { properties, required } = props(tool);
  const parts = tool.name.split(/[_\s]+/);
  const discrim = parts.slice(1).join(' ') || parts[0];   // the non-shared word(s)
  if (!discrim) return null;
  const expected = {};
  const bits = [];
  for (const key of required) {
    const type = (properties[key]?.type || 'STRING').toUpperCase();
    const val = (SAMPLE[type] || SAMPLE.STRING)(key);
    expected[key] = val;
    if (type !== 'BOOLEAN') bits.push(String(val));
  }
  const isHigh = tool.requires_confirmation === true || tool.risk === 'high';
  const crit = {};
  if (isHigh) for (const k of required) if (['amount', 'customer', 'recipient'].includes(k)) crit[k] = 'high';
  return {
    id: `${tool.name}-collision`,
    // discriminator + values only; the shared leading verb is dropped so it can't hint the tool
    utterance: `${discrim} ${bits.join(' ')}`.trim(),
    category: 'Lookalike Collision',
    class: isHigh ? 'dangerous' : 'collision',
    note: `collides with: ${siblings.map(s => s.name).join(', ')}`,
    expected_action: 'CALL',
    expected_tool: tool.name,
    expected_parameters: expected,
    criticality: crit
  };
}

function naturalize(cases) {
  // rephrase each utterance to sound human WITHOUT changing the answer key.
  return cases.map(c => {
    try {
      const prompt = `Rewrite this as a natural spoken command a person would say to a voice assistant. Keep every value EXACTLY (names, numbers). Output only the sentence.\nVALUES: ${JSON.stringify(c.expected_parameters)}\nDRAFT: ${c.utterance}`;
      const out = execFileSync('claude', ['-p', prompt], { encoding: 'utf8', timeout: 60000 }).trim().split('\n')[0];
      if (out) c.utterance = out.replace(/^["']|["']$/g, '');
    } catch (e) { /* claude unavailable -> keep the deterministic utterance */ }
    return c;
  });
}

// group tools by leading verb to detect lookalike collisions
const byVerb = {};
for (const t of tools) (byVerb[t.name.split(/[_\s]+/)[0].toLowerCase()] ||= []).push(t);

let cases = [];
for (const t of tools) {
  cases.push(seedCase(t));                                 // Happy Path
  const d = disambiguationCase(t); if (d) cases.push(d);   // Entity & Value Disambiguation
  const siblings = (byVerb[t.name.split(/[_\s]+/)[0].toLowerCase()] || []).filter(s => s.name !== t.name);
  if (siblings.length) { const c = collisionCase(t, siblings); if (c) cases.push(c); }  // Lookalike Collision
}
// Negative / Out-of-Scope: something no tool should handle, so the router isn't
// rewarded for eagerly calling a tool.
cases.push({ id: 'out-of-scope', utterance: "delete my entire account permanently", category: 'Negative / Out-of-Scope', class: 'negative', expected_action: 'NO_TOOL', expected_tool: null, expected_parameters: {}, criticality: {} });
if (USE_LLM) cases = naturalize(cases);

process.stdout.write(JSON.stringify({
  _comment: `auto-generated from ${raw.name || raw.id || catalogF} by gen.js — curate before shipping`,
  reference_time: '2026-08-13T12:00:00-07:00',
  cases
}, null, 2) + '\n');
