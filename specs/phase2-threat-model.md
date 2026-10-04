# Phase 2 — Threat model + frozen EIP-712 action schemas (DESIGN)

Status: DESIGN 2026-10-03. Schemas below are the contract baseline to implement in Phase 4 and test in Phase 5. Field order is signing-significant. All financial types bind `chainId + verifyingContract + dealId + agreementDigest + nonce + expiresAt` unless noted.

## 1. Threat model (must be covered by implementation + Phase 5/11 tests)

| Actor / vector | Abuse | Control (locked) |
|---|---|---|
| Buyer+seller collusion for subsidy | Manufacture disputes to drain reviewer/sponsor pool | Admission concurrency + $10k/24h pair caps (P-14), subsidy metrics, indexer wash-trade flags; no retroactive charges |
| Malicious buyer | Late freeze after inspection; repeated freezes | `< deadline` admission, permanent `disputeUsed`, lapse → T08 with same anchor; no restore |
| Malicious seller | False delivery claim; re-declaration to reset clock | One `markDelivered`, delivery commitment hash required, no clock reset |
| Stolen wallet | Attacker funds/settles as victim | No silent wallet replacement on funded deals; recovery only via governance-delayed registry + funded-deal wallets immutable; login sig ≠ financial auth |
| Compromised reviewer | Forged award, single-panel takeover | Quorum in contract (2-of-3 / 3-of-5), disjoint primary/fallback sets, distinct epochs, cancel-only veto, `executeAt < escapeAt` check |
| Compromised governance/admission | Mint settlement rights, redirect funds | Admission can only deny NEW funding, cannot settle/redirect; pause is funding-only; rotation 72h; quorum-replacement = arbitration authority with same quorum+delay |
| Relayer/keeper | Front-run, censor, reorder to steal expiry | All authorizations carry `expiresAt` + consumed nonces + phase checks; permissionless progression (T04/T08/T10/T12/T15/T16/T22/T23) so censorship only delays, never steals; payment bound to deal (phase2-architecture §3) |
| Signature replay | Same sig funds twice / settles two deals | One-use agreement nonce + revocation mapping + payment nonce + settlement nonce; cross-chain replay blocked by chainId+contract; stale offers invalidated by phase/nonce change |
| Accidental/direct transfers | Unsolicited USDC credited as deal | Only `fund`/`postBond` create liabilities; direct transfers = rescuable excess (`tokenBalance - liabilities`), never credited |
| Evidence omission/substitution | Operator drops files pre-anchor | Delivery commitment at declaration; append-only manifests with prev-hash chain; signed receipts; retention 2y/5y; reviewers rule on manifest only |
| RPC/indexer outage | Fake "confirmed" delivery, missed deadlines | Chain state authoritative; display pending vs included; confirmation policy safe-before-ship; contract deadlines need no keeper/indexer |
| Aggregate splitting | Evade T2/T3 quorum with many small deals | Admission aggregate monitoring; compromise-loss analysis per panel key-set, not per deal; expansion only on measured capacity |

Pending-ruling after revocation: queue-time epoch check; validly queued award survives rotation unless vetoed in delay (P-07). Admission approvals expire in 24h and are void while paused.

## 2. Frozen EIP-712 schemas (order-sensitive; `//` = field order)

Domain: `EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)` with name `MidmanEscrow`, version `1`.

```text
DealTerms: dealId bytes32, termsVersion uint32, buyerAddress address, sellerAddress address,
  sellerPayoutAddress address, buyerRefundAddress address, buyerBondRefundAddress address,
  sellerBondRefundAddress address, token address, principal uint256, quotedPlatformFee uint256,
  buyerFeeBps uint16, agreementHash bytes32, feePolicyId bytes32, deliveryPeriodSeconds uint32,
  inspectionPeriodSeconds uint32, categoryPolicyId bytes32, readinessPolicyId bytes32,
  readinessConsentHash bytes32, evidencePolicyId bytes32, bondPolicyId bytes32,
  arbitrationPolicyId bytes32, outagePolicyId bytes32, catastrophicPolicyId bytes32,
  platformFeeRecipient address, arbitrationCostRecipient address, fundingDeadline uint64,
  nonce bytes32, salt bytes32, factory address, implementation address, custodyAddress address
  (32-field order matches contract-spec.json dealTermsTypes)

RevokeTerms: dealId bytes32, agreementDigest bytes32, revoker address, nonce bytes32, expiresAt uint64
MarkDelivered: dealId bytes32, agreementDigest bytes32, actor address, manifestHash bytes32, nonce bytes32, expiresAt uint64
OpenDispute: dealId bytes32, agreementDigest bytes32, actor address, reasonCode uint8, initialCommitment bytes32, nonce bytes32, expiresAt uint64
EscalateDispute: dealId bytes32, agreementDigest bytes32, actor address, collateralAmount uint256, collateralSource uint8, bondPolicyId bytes32, nonce bytes32, expiresAt uint64
ApproveSeller: dealId bytes32, agreementDigest bytes32, actor address, terminalPolicyVersion bytes32, nonce bytes32, expiresAt uint64
RefundBuyer: dealId bytes32, agreementDigest bytes32, actor address, terminalPolicyVersion bytes32, nonce bytes32, expiresAt uint64
MutualSettlement: dealId bytes32, agreementDigest bytes32, sellerAward uint256, buyerBondCost uint256, sellerBondCost uint256, expectedPhase uint8, settlementNonce bytes32, expiresAt uint64
  (requires BOTH buyer and seller signatures over identical struct)
ReserveExistingClaim: dealId bytes32, agreementDigest bytes32, owner address, sourceClaimId bytes32, amount uint256, party uint8, nonce bytes32, expiresAt uint64
EvidenceManifest: dealId bytes32, agreementDigest bytes32, uploader address, sequence uint32, prevCommitment bytes32, fileHashes bytes32[], metadataCommitment bytes32, nonce bytes32, expiresAt uint64
Ruling: dealId bytes32, agreementDigest bytes32, arbitrationPolicyId bytes32, origin uint8, rulingNonce bytes32, sellerAward uint256, buyerBondCost uint256, sellerBondCost uint256, evidenceCommitment bytes32, authEpoch uint64, queueExpiry uint64
  (N quorum signatures over identical struct; deduplicate approvers; primary sigs ≠ fallback sigs)
VetoRuling: dealId bytes32, rulingDigest bytes32, authority address, nonce bytes32, expiresAt uint64
  (no award/recipient fields by construction)
FundingAdmission: agreementDigest bytes32, minPolicyId bytes32, admissionNonce bytes32, expiresAt uint64, expectedUnfunded bool
  (signer = risk role; cannot settle/redirect; void while paused)
LoginChallenge: domain string, chainId uint256, wallet address, nonce bytes32, expiresAt uint64, purpose string
  (PURPOSE = "Midman sign-in only, no funds authorized"; verifiers must reject login sigs as financial auth)
```

Rules: consume each financial nonce atomically on success; revoke unfunded digests irreversibly; phase-check every action (`expectedPhase` enforced where present); reject `queueExpiry`/`executeAt >= escapeAt`; EIP-1271 smart-wallet sigs validated at execution (state-dependent).

## 3. Phase 2 freeze checklist (gate to Phase 4)

- [ ] Hub-vs-vault measurements filled (phase2-architecture §1) + decision recorded.
- [ ] USDC fork checklist green (decimals, 3009 payee-binding, approve fallback, exact-amount, failure isolation, wallet matrix).
- [ ] Payment-binding test vectors defined (same-amount replay, front-run, expiry, wrong recipient).
- [ ] Outage prototype scenarios 1–8 pass on fork (phase2-outage §4) + gas/lookback recorded.
- [ ] Schemas above pinned byte-for-byte (reference test vectors in Phase 5); domain/custody branch selected.
- [ ] External design review of this baseline completed; findings dispositioned.
- [ ] `contract-spec.json` freeze: no new DealTerms fields after this point without major version bump.
