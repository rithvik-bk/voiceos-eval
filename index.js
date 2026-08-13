// index.js — library entry point. Lets VoiceOS drop the gate straight into their
// agent loop:  import { guard } from 'voiceos-eval'
//
//   const check = guard(userMessage, toolName, args, catalog);
//   if (!check.ok) { showMismatchOnCard(check.reason); }   // else proceed
//
// Deterministic and dependency-free, so it runs in well under a millisecond — safe to
// call on every high-risk tool call, right before the confirmation card is shown.

const { verify, highRiskFromCatalog } = require('./verify.js');
const { scoreCase, aggregate, wordsToNumber, paramMatches } = require('./score.js');

// guard(userMessage, toolName, args, catalog?) -> { ok: boolean, reason: string }
// Pass the integration's manifest as `catalog` so the high-risk set comes from its own
// flags; omit it to use the built-in default high-risk set.
function guard(userMessage, toolName, args, catalog) {
  const highRisk = catalog ? highRiskFromCatalog(catalog) : undefined;
  return verify(userMessage, toolName, args || {}, highRisk);
}

module.exports = { guard, verify, highRiskFromCatalog, scoreCase, aggregate, wordsToNumber, paramMatches };

// quick self-check / latency demo: `node index.js`
if (require.main === module) {
  const catalog = { tools: [{ name: 'refund_payment', requires_confirmation: true }] };
  const bad = guard('refund forty dollars to Jane', 'refund_payment', { customer: 'John', amount: 400 }, catalog);
  const good = guard('refund forty dollars to Jane', 'refund_payment', { customer: 'Jane', amount: 40 }, catalog);
  const N = 10000, t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) guard('refund forty dollars to Jane', 'refund_payment', { customer: 'John', amount: 400 }, catalog);
  const perCall = Number(process.hrtime.bigint() - t0) / N / 1e6;
  console.log('\n  import { guard } from "voiceos-eval"\n');
  console.log('  mismatch ->', bad);
  console.log('  match    ->', good);
  console.log(`\n  latency: ${perCall.toFixed(4)} ms/call over ${N} calls (deterministic, no model)\n`);
}
