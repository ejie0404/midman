# Phase 7 Acceptance — End-to-End Journeys

Scope: `packages/contracts/script/Deploy.s.sol`, `packages/contracts/test/e2e/Journey.t.sol`.
Toolchain: solc 0.8.26 via-IR, OZ 5.0.2, forge-std v1.17, forge 1.8.4
(`C:/Users/subze/AppData/Local/Temp/opencode/foundry/forge.exe`), local EVM only.
No src/, existing-test, or spec modifications. No commits.

Common parameters: P = 100_000_000 (100 USDC), quoted fee F = 500_000
(25 bps on 7200 s floored to the 0.50 USDC minimum), buyerFeeBps = 10_000
(buyer prepays F), bond = 5_000_000 per contesting party, tier-0 quorum 2,
exec delay 24 h. Buyer/seller each start at 1_000_000_000; fee = 0xFEE,
arb = 0xA8B start at 0.

## Results

`forge test` (full suite): **136 passed, 0 failed, 4 skipped** (count at Phase 7; the current full suite is 203 + 4 fork-skip) (skips are
pre-existing). Journey contract alone: 5/5 pass.

| Journey | Result | Test gas |
|---|---|---|
| A happy path (3009 fund → deliver → release → claims) | PASS | 1,517,426 |
| B full dispute (partial S=70% primary ruling) | PASS | 3,030,915 |
| C missing-respondent buyer win + catastrophic escape (2nd deal) | PASS | 4,225,284 |
| D relayer-submitted calldata equivalence + direct claimFor | PASS | 1,544,978 |
| E mutual settlement mid-dispute + stale-offer rejection | PASS | 2,606,146 |

## Gas per key action (`forge test --match-contract JourneyTest -vv`)

| Action | Gas |
|---|---|
| A fund (3009) | 742,534 |
| A deliver | 127,463 |
| A release | 234,164 |
| A claim seller / fee | 68,093 / 80,693 |
| B fund (allowance) | 803,090 |
| B openDispute | 83,562 |
| B escalate | 246,576 |
| B respondent bond | 194,298 |
| B evidence commitment | 196,229 |
| B advanceToPrimary | 74,737 |
| B queueRuling | 281,236 |
| B executeRuling | 393,303 |
| C catastrophicEscape | 280,891 |
| D fund via relayer (3009) | 744,534 |
| D deliver via relayer (signed) | 167,357 |
| D release via relayer (signed) | 276,015 |
| D claim via relayer / direct by recipient | 73,224 / 83,338 |
| E mutualSettlement | 452,502 |

## Ledger vectors verified (all exact, smallest units)

- **A** — funded 100_500_000. Claims: buyerPF 0, sellerPF 100_000_000,
  fee 500_000, bonds/arb 0. Sum == funded. Final: buyer 899_500_000,
  seller 1_100_000_000, fee 500_000, `totalLiabilities() == 0`,
  hub balance 0.
- **B** — inflow 110_500_000 (= 100_500_000 + 2×5_000_000 bonds).
  S=70_000_000 → E=350_000. Claims: buyerPF 30_150_000, sellerPF
  70_000_000, fee 350_000, buyerBond 1_500_000, sellerBond 3_500_000,
  arb 5_000_000 (Cb=3.5M, Cs=1.5M proportional). Sum == inflow. Final:
  buyer 926_150_000, seller 1_068_500_000, fee 350_000, arb 5_000_000,
  liabilities 0. Evidence commitment submitted on-chain first; the queued
  ruling references the resulting `manifestHead`.
- **C1** (S=0, no respondent bond) — inflow 105_500_000. Claims: buyerPF
  100_500_000, buyerBond 5_000_000 (fully refunded, Cb=0), all else 0,
  arb recipient stays 0. **C2** (escape after 60-day warp, both bonds
  posted) — inflow 110_500_000. Claims: buyerPF 50_500_000
  (P/2 + prepaid), sellerPF 50_000_000, buyerBond 5_000_000, sellerBond
  5_000_000, fee 0. Combined final: buyer 950_000_000, seller
  1_050_000_000, fee 0, liabilities 0. Production 60-day constant untouched.
- **D** — same vector as A via relayer-submitted signed payloads
  (`actionDigest` + DELIVER/APPROVE struct hashes signed by seller/buyer,
  submitted by `0x1E1A7E12`): sellerPF 100_000_000, fee 500_000.
  Relayer-triggered `claimFor(1)` still pays the seller; fee recipient
  pulls `claimFor(2)` directly. Relayer balance 0, liabilities 0.
- **E** — inflow 110_500_000, S=40_000_000 with bounded costs
  (buyerCost 1M, sellerCost 2M). Claims: buyerPF 60_300_000, sellerPF
  40_000_000, fee 200_000, buyerBond 4_000_000, sellerBond 3_000_000,
  arb 3_000_000. Stale offer at settlementNonce 1 reverts `BadNonce`
  after the respondent bond moves the nonce to 2; fresh offer at nonce 2
  settles. Final: buyer 958_800_000, seller 1_038_000_000, fee 200_000,
  arb 3_000_000, liabilities 0.

Every journey asserts conservation (claims sum == funded + bonds posted),
pre-claim solvency (`hub balance == totalLiabilities`), and ends with
`totalLiabilities() == 0` and hub balance 0.

## Defects found / fixed

1. `script/Deploy.s.sol` used `fallback` as a variable name — reserved
   keyword, first `forge build` failed. Renamed to `fb`.
2. `test/e2e/Journey.t.sol` used `after` as a variable name — reserved
   keyword, same build failure. Renamed to `vAfter`.
3. Both were new-file authoring errors (not protocol issues); no src/
   defect found. Full suite green with no changes outside the allowed scope.

## Deploy script

`forge script script/Deploy.s.sol` (dry-run OK, gas 9,079,690): deploys
MockUSDC/MockFeed unless `USDC_ADDRESS`/`FEED_ADDRESS` are set; roles from
`GOVERNANCE`/`PAUSER`/`ADMISSION_SIGNER`/`TREASURY` (default broadcaster);
3/3/3 panels from `*_ADDR_<i>` / `*_PK_<i>` or deterministic local keys;
registers the 8 standard policies (fee, cat min 3600, no-readiness,
evidence, 5-USDC bonds, all-tiers arb 0x07, outage grace 1800 max 8,
catastrophic) and logs every address plus policy IDs. Sepolia/Base usage
documented in the file header.
