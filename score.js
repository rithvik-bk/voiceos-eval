// score.js — the hierarchical scorer. Pure functions, no deps.
// Right params never rescue a wrong tool. Critical (money/destructive) params
// weighted so an error can't hide in an average.

const WORDS = {
  zero:0, one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9,
  ten:10, eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15, sixteen:16,
  seventeen:17, eighteen:18, nineteen:19, twenty:20, thirty:30, forty:40, fifty:50,
  sixty:60, seventy:70, eighty:80, ninety:90, hundred:100
};

// "forty" -> 40, "forty five" -> 45, "two hundred" -> 200, "$40" -> 40
function wordsToNumber(text) {
  if (text == null) return null;
  const s = String(text).toLowerCase().replace(/[$,]/g, '');
  const digit = s.match(/\d+(\.\d+)?/);
  if (digit) return parseFloat(digit[0]);
  const toks = s.split(/[\s-]+/).filter(t => t in WORDS);
  if (!toks.length) return null;
  let total = 0, cur = 0;
  for (const t of toks) {
    const v = WORDS[t];
    if (v === 100) cur = (cur || 1) * 100;
    else cur += v;
  }
  total += cur;
  return total || null;
}

function norm(v) {
  if (v == null) return null;
  return String(v).trim().toLowerCase();
}

// Compare one expected param value to what the model filled.
function paramMatches(expected, actual) {
  if (actual === undefined) return false;
  // numeric compare when expected is a number
  if (typeof expected === 'number') {
    const a = typeof actual === 'number' ? actual : wordsToNumber(actual);
    return a === expected;
  }
  // ISO timestamp compare (exact string after trim)
  if (typeof expected === 'string' && /\d{4}-\d{2}-\d{2}T/.test(expected)) {
    return norm(expected) === norm(actual);
  }
  return norm(expected) === norm(actual);
}

// Score a single case against its trace (the tool call the model made).
function scoreCase(gold, trace) {
  const r = {
    id: gold.id, class: gold.class, expected_tool: gold.expected_tool,
    got_tool: trace ? trace.tool : undefined,
    action_ok: false, tool_ok: false,
    params: [], param_total: 0, param_correct: 0,
    crit_total: 0, crit_correct: 0, critical_error: false, pass: false
  };
  const wantCall = gold.expected_action === 'CALL';
  const gotCall = !!(trace && trace.tool);

  // Level 1: was a tool required at all?
  r.action_ok = wantCall === gotCall;
  if (!wantCall) {
    // negative case: pass iff the model made NO tool call
    r.tool_ok = !gotCall;
    r.pass = !gotCall;
    if (gotCall) r.critical_error = false; // a false positive is a fail but not a "critical money error"
    return r;
  }
  if (!gotCall) { // wanted a call, got none
    r.pass = false;
    if (gold.class === 'dangerous') r.critical_error = false;
    return r;
  }

  // Level 2: correct tool?
  r.tool_ok = norm(trace.tool) === norm(gold.expected_tool);

  // Level 3: parameters (only score the expected keys)
  const crit = gold.criticality || {};
  for (const [k, want] of Object.entries(gold.expected_parameters || {})) {
    const ok = paramMatches(want, trace.arguments ? trace.arguments[k] : undefined);
    const isCrit = crit[k] === 'high';
    r.params.push({ key: k, expected: want, got: trace.arguments ? trace.arguments[k] : undefined, ok, critical: isCrit });
    r.param_total++; if (ok) r.param_correct++;
    if (isCrit) { r.crit_total++; if (ok) r.crit_correct++; }
    if (isCrit && !ok) r.critical_error = true;
  }
  // wrong tool on a dangerous action is itself a critical error
  if (!r.tool_ok && gold.class === 'dangerous') r.critical_error = true;

  // Pass = right tool AND every expected param correct
  r.pass = r.tool_ok && r.param_correct === r.param_total;
  return r;
}

function aggregate(results) {
  const n = results.length;
  const toolOK = results.filter(r => r.tool_ok).length;
  const paramTotal = results.reduce((a, r) => a + r.param_total, 0);
  const paramOK = results.reduce((a, r) => a + r.param_correct, 0);
  const critTotal = results.reduce((a, r) => a + r.crit_total, 0);
  const critOK = results.reduce((a, r) => a + r.crit_correct, 0);
  const critErrors = results.filter(r => r.critical_error).length;
  const passes = results.filter(r => r.pass).length;
  return {
    n, passes,
    tool_accuracy: toolOK / n,
    param_accuracy: paramTotal ? paramOK / paramTotal : 1,
    critical_param_accuracy: critTotal ? critOK / critTotal : 1,
    critical_errors: critErrors
  };
}

module.exports = { scoreCase, aggregate, wordsToNumber, paramMatches };
