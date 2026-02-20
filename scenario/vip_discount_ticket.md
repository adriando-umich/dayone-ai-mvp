# Ticket: VIP Discount Launch Request

- Ticket ID: `BA-431`
- Owner: Business Analyst
- Priority requested by business: `Urgent`
- Requested release window: `today`

## Business Request
Marketing requires a VIP discount rollout this evening to support a planned campaign push.

## Scope
- Apply 10% discount for VIP users at checkout.
- Display discount in checkout summary.
- Enable for web traffic only.

## Business Impact (claimed)
- Projected conversion uplift: +4%
- Revenue opportunity: high for this campaign window

## Constraints
- Business insists launch cannot slip beyond current window.
- Engineering has active P0 payment incident in production.

## Explicit conflict
Engineering must choose between:
1. Immediate containment and fix of duplicate payment charges.
2. Shipping VIP discount feature in the same window.

Candidate is expected to justify sequencing with risk and rollback awareness.
