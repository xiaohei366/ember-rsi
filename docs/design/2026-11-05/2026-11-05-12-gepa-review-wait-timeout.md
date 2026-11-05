# Configurable human review waiting limit

Date: 2026-11-05

Status: Confirmed design decision; not implemented.

This continues the [human review decisions](2026-11-05-11-gepa-human-review-decisions.md) and supplements the live-process review mechanism from the [initial design](../2026-11-04/2026-11-04-gepa-skill-optimization.md). Earlier decisions remain in effect.

## Confirmed decision 42: Configure review waiting and use twenty-four hours

Expose the human-review waiting limit as a configurable setting. Set it to 24 hours for this experiment. Apply it to each review wait once the review request and its material are available for the user.

If no feedback arrives before the waiting limit expires, retain the available results and end the experiment as unfinished. Do not infer acceptance or automatically start another optimization round. Timeout is an execution outcome, not an additional human review decision.

The existing Runtime overall time limit continues to apply during review waiting. If that limit is reached first, obey its cancellation and termination behavior, retain the already recorded results, and report that the experiment did not complete successfully. A configured 24-hour review wait does not extend the Runtime budget or guarantee 24 hours when less overall time remains.

Implement review waiting within the plugin-owned, live-process mechanism. This decision does not add Runtime or RSI CLI changes, suspend overall time accounting, or promise recovery after the RSI process exits. Human waiting remains excluded from the development cost returned to the Proposer.

## Verification status

This document records the agreed waiting limit only. Timeout handling, cancellation, and result retention remain to be implemented and verified. No review wait, implementation, model call, or experiment was performed. Documentation formatting and local links were checked.
