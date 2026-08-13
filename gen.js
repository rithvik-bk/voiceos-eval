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
  STRING: (name) => ({ recipient: 'Sam', customer: 'Sam', title: 'Standup', playlist: 'Focus', track: 'Yesterday', description: 'monthly plan' }[name] || `${name}X`),
  NUMBER: (name) => ({ amount: 25, duration_minutes: 45, limit: 5 }[name] || 3),
  BOOLEAN: () => true
};

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
function disambiguationCase(tool) {
  const { properties, required } = props(tool);
  const amtKey = required.find(k => /amount/i.test(k));
  if (!amtKey) return null;
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

let cases = [];
for (const t of tools) {
  cases.push(seedCase(t));                       // Happy Path
  const d = disambiguationCase(t); if (d) cases.push(d);  // Entity & Value Disambiguation
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
