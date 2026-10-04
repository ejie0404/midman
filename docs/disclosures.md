# Midman V1 — User-facing disclosures

Status: 2026-10-04. Publish these disclosures **before any funding**. Each item
is a one-line plain-language statement with its policy reference in
`specs/policy-register.md` (P-xx) or `implementation-plan.md`. Contract state is
authoritative over every label, screen, or support message here.

## What you are using

1. **Asset and network.** You are escrowing **native USDC on Base** (chain ID 8453, token `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`); no other asset or chain is supported. _(implementation-plan.md "Purchase asset / network"; P-16)_
2. **Minimum principal.** A deal's principal must be **at least 5.00 USDC**; there is **no user-facing maximum**, so larger deals are admission-gated rather than capped. _(implementation-plan.md table; P-14)_
3. **No silent cap.** Midman will not introduce a hidden principal ceiling; rollout pace is controlled through funding admission and capacity, and any limit change is a new registered admission policy, never an edit to a funded deal. _(P-14, P-15)_

## Fees

4. **Minimum fee.** The quoted platform fee is at least **0.50 USDC**, and at a 5.00 USDC principal the 0.50 USDC minimum fee is an effective **10.00%** (0.50 on 5.00); the disclosed tier rate governs larger deals. _(P-01; implementation-plan.md fee tiers)_
5. **Duration pricing.** Quoted fee rate by agreed delivery-plus-inspection duration: **≤3h 0.25%; >3h and <24h 0.50%; 24h–3d 0.70%; >3d–7d 1.00%; >7d 2.00%**, quoted with rounding up. _(P-01; implementation-plan.md table)_
6. **Partial settlement.** If a deal settles for only part of the principal, the earned fee is **proportional** — `floor(quotedFee × sellerAward ÷ principal)` — and the buyer pays its signed share (0%, 50%, or 100%) with the seller covering the remainder; you never pay the full quoted fee on an unreleased amount. _(P-01, P-03; implementation-plan.md "Actual normal settlement fee")_
7. **Who pays.** The buyer pays the fee by default; seller-pays and 50/50 are signed options, fixed in the agreement before funding. _(implementation-plan.md "Fee payer")_

## Disputes and deadlines

8. **One free initial dispute.** The buyer gets **one unilateral freeze per deal with no bond**; using it is free, but after that the right is permanently exhausted. _(P-04, P-08; implementation-plan.md "Initial dispute")_
9. **Escalation needs a real bond.** To escalate to arbitration, **each actively contesting party posts a separate real bond of at least 5.00 USDC** (USDC or vested unencumbered claims); the initial free dispute cannot be re-used. _(P-03, P-04; implementation-plan.md "Escalation collateral")_
10. **Negotiation then escalation.** After a dispute there are **24 hours for self-resolution**, followed by a **24-hour escalation window**; miss the window and the inspection schedule resumes with the dispute right gone. _(P-06, P-10; implementation-plan.md "Negotiation / escalation")_
11. **Respondent bond is optional.** The respondent (normally the seller) **may** post a bond and contest; not participating causes **no default loss and no fictional revenue**, and review proceeds on the claimant's evidence plus the delivery record. _(P-03, P-06)_
12. **Evidence cutoff.** Evidence is due within **24 hours of escalation** (`escalatedAt + 24h`); late submissions are rejected and reviewers cannot consider off-manifest files. _(P-13; P-12)_
13. **Quorum and execution delay.** Rulings need a multi-signer panel, with stronger panels and longer delays for bigger deals: **5–1,000 USDC → 2-of-3, 24h delay; >1,000–10,000 USDC → 3-of-5, 48h delay; >10,000 USDC → 3-of-5 plus a veto no-objection, 72h delay**. _(P-05)_
14. **Cancel-only veto.** A veto can only **cancel** a queued ruling (for policy violation, fraud, key compromise, or an out-of-bounds award); it can never redirect funds or substitute its own award. _(P-05, P-07)_
15. **Exhausted-dispute-right warning.** Before you fund, Midman shows that the free dispute is one-use and that missing the 24h escalation window **permanently ends your arbitration right**; expiring short-deal readiness consent also expires and cannot be recycled. _(P-08, P-11; implementation-plan.md "Missed escalation")_

## Fixed catastrophic fallback

16. **Fixed 60-day 50/50.** Properly escalated, still-unsettled disputes convert after a fixed **60 days** into a **50/50 principal split** — with the odd unit to the buyer, **all fees waived**, and **all posted bonds refunded** (example: 5,000,001 units → buyer 2,500,001, seller 2,500,000, fees 0). The 60-day cutoff is never extended. _(P-02, P-08)_
17. **Voluntary exits survive.** Release, refund, and mutually signed settlements remain available after the 60-day cutoff until the split executes. _(P-08)_

## Account deals, credentials, and truth

18. **No post-settlement warranty for game accounts.** Game-account deals settle on transfer; Midman gives **no post-settlement warranty**, and a later account recovery by the seller is handled only as a support report (reopening is not available after inspection). _(P-12)_
19. **Never share credentials.** Passwords, private keys, recovery phrases, and full secret codes must **never** be posted in chat, support tickets, evidence previews, or on-chain commitments; the platform warns and blocks known secret patterns. _(P-12)_
20. **Contract state is authoritative.** Your on-chain deal is the source of truth: pending is not included, and any display, projection, or support statement that disagrees with the contract is wrong. _(P-15; docs/incident-runbooks.md ground rules)_
