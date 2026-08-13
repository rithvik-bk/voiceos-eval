// verify.js — the pre-execution safety gate. The thing confirmation cards CAN'T do:
// it runs BETWEEN "model chose a tool" and "action fires", re-derives the money-
// critical facts from the user's own words, and BLOCKS on mismatch. Independent of
// the model that made the choice. Deterministic here (no API key); in production the
// free-text leg can escalate to a cheap model call.

// Spoken-money + name extraction that survives real ASR transcripts (lowercase, words
// not digits). This is a voice product's actual input, so the gate parses it directly.
const NUM_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90
};
// "fifty four" -> 54, "one thousand" -> 1000, "one hundred twenty three" -> 123
function phraseToNumber(words) {
  let total = 0, current = 0, any = false;
  for (const w of words) {
    if (w === 'and') continue;
    if (w in NUM_WORDS) { current += NUM_WORDS[w]; any = true; }
    else if (w === 'hundred') { current = (current || 1) * 100; any = true; }
    else if (w === 'thousand') { total += (current || 1) * 1000; current = 0; any = true; }
    else if (w === 'million') { total += (current || 1) * 1000000; current = 0; any = true; }
    else break;
  }
  return any ? total + current : null;
}
// pull the amount the user actually said — anchored to a currency word so a stray
// number elsewhere in the sentence can't be mistaken for the amount. Returns 0 as 0.
function parseAmount(utterance) {
  const u = utterance.toLowerCase().replace(/,/g, '');
  let m = u.match(/\$\s*(\d+(?:\.\d+)?)/) || u.match(/(\d+(?:\.\d+)?)\s*(?:dollars?|bucks)/);
  if (m) return parseFloat(m[1]);
  const words = u.replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  const collectBefore = (idx) => {
    const acc = [];
    for (let i = idx - 1; i >= 0; i--) {
      const w = words[i];
      if (w in NUM_WORDS || w === 'hundred' || w === 'thousand' || w === 'million' || w === 'and') acc.unshift(w);
      else break;
    }
    return acc.length ? phraseToNumber(acc) : null;
  };
  const di = words.findIndex(w => w === 'dollars' || w === 'dollar' || w === 'bucks');
  const ci = words.findIndex(w => w === 'cents' || w === 'cent');
  const dollars = di >= 0 ? collectBefore(di) : null;
  const cents = ci >= 0 ? collectBefore(ci) : null;
  if (dollars == null && cents == null) return null;
  return (dollars || 0) + (cents || 0) / 100;
}

// Fallback set for the standalone demo. In real use the high-risk set is derived
// from the integration manifest itself (requires_confirmation === true || risk:high),
// so the gate is universal — ANY integration's destructive tools are checked with
// zero per-integration config. See highRiskFromCatalog().
const DEFAULT_HIGH_RISK = new Set(['refund_payment', 'create_payment', 'delete_issue', 'send_wire']);

// destructive / irreversible / external-effect verbs — used only when a manifest
// ships no explicit risk flags (like the first-party export), so the gate still has
// a sensible high-risk set instead of falling back to Stripe-only names.
const RISK_WORDS = /(delete|trash|remove|permanent|merge|send|share|pay|charge|refund|payout|wire|cancel|archive|move_to_trash|publish)/i;

// Any tool the manifest flags as needing confirmation / high risk gets the pre-fire
// check. If the manifest carries no flags at all, fall back to a name heuristic.
function highRiskFromCatalog(catalog) {
  const tools = catalog.tools || [];
  const flagged = new Set();
  for (const t of tools) if (t.requires_confirmation === true || t.risk === 'high') flagged.add(t.name);
  if (flagged.size) return flagged;
  const heuristic = new Set();
  for (const t of tools) if (RISK_WORDS.test(t.name)) heuristic.add(t.name);
  return heuristic.size ? heuristic : DEFAULT_HIGH_RISK;
}

// pull the recipient/customer the user named. Anchors to "to X" / "X's" first (works
// on lowercase ASR text), then a verb+name pattern that refuses number/currency words
// so it can't grab the amount as the recipient.
function utteranceParty(u) {
  const s = u.trim();
  let m = s.match(/\bto\s+([a-z][a-z]*)/i) || s.match(/\b([a-z][a-z]*)'s\b/i);
  if (m) return m[1];
  m = s.match(/\b(?:charge|refund|pay|send)\s+([a-z][a-z]*)/i);
  if (m) {
    const w = m[1].toLowerCase();
    if (!(w in NUM_WORDS) && !/^(dollars?|cents?|bucks)$/.test(w)) return m[1];
  }
  return null;
}

// verify(utterance, tool, args, highRisk?) -> { ok, reason }
// highRisk: a Set of tool names to check (pass highRiskFromCatalog(catalog) for universal behavior).
function verify(utterance, tool, args, highRisk = DEFAULT_HIGH_RISK) {
  if (!highRisk.has(tool)) return { ok: true, reason: 'not a high-risk action' };
  const said = parseAmount(utterance);
  const party = utteranceParty(utterance);
  const problems = [];

  // real integrations name these fields differently — check known aliases
  const pick = (keys) => { for (const k of keys) if (args[k] != null) return args[k]; return null; };
  let amt = pick(['amount', 'amountDollars', 'amount_dollars']);
  const cents = pick(['amount_cents', 'amountCents']);
  if (amt == null && cents != null) amt = Number(cents) / 100;
  const who = pick(['customer', 'recipient', 'to', 'destination']);

  // compare in whole cents to avoid float drift (54 + 0.94 style)
  if (said != null && amt != null && Math.round(Number(amt) * 100) !== Math.round(said * 100))
    problems.push(`amount: you said $${said}, the call would send $${amt}`);

  // containment match so "Maya" agrees with "Maya Weber" (first name vs full name);
  // only flag when neither name contains the other.
  if (party && who) {
    const a = party.toLowerCase(), b = String(who).toLowerCase();
    if (!b.includes(a) && !a.includes(b))
      problems.push(`recipient: you said "${party}", the call targets "${who}"`);
  }

  if (problems.length)
    return { ok: false, reason: problems.join('  |  ') };
  return { ok: true, reason: 'utterance and arguments agree' };
}

module.exports = { verify, highRiskFromCatalog };

// CLI demo: `node verify.js`
if (require.main === module) {
  const cases = [
    ['refund forty dollars to Jane', 'refund_payment', { customer: 'John', amount: 400 }],
    ['refund forty dollars to Jane', 'refund_payment', { customer: 'Jane', amount: 40 }],
    ['charge Alice fifty dollars', 'create_payment', { customer: 'Alice', amount: 50 }]
  ];
  console.log('\n  VERIFICATION GATE — high-risk actions checked before they fire\n');
  for (const [u, tool, args] of cases) {
    const v = verify(u, tool, args);
    const tag = v.ok ? '  ALLOW ' : '  BLOCK ';
    console.log(`${tag} "${u}"`);
    console.log(`         -> ${tool}(${JSON.stringify(args)})`);
    console.log(`         -> ${v.ok ? 'OK   ' : 'STOP '} ${v.reason}\n`);
  }
}
