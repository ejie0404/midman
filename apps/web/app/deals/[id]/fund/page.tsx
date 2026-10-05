"use client";

import { use, useCallback, useEffect, useState } from "react";
import { ApiError } from "../../../../lib/api";
import {
  CHAIN_ID,
  HUB_ADDRESS,
  USDC_ADDRESS,
  connectWallet,
  ensureChainId,
  getAccount,
  getWalletClient,
} from "../../../../lib/wallet";
import {
  assembleRelayPayload,
  directFund,
  fetchFundingBundle,
  fetchFundingStatus,
  signAllowance,
  signDealTerms,
  signReadiness,
  submitDealSignatures,
  submitRelayFund,
  waitForFundingEvent,
  type FundingBundle,
} from "../../../../lib/funding";
import { formatUnixDate } from "../../../../lib/money";
import { useDeal } from "../../../components/useDeal";
import Countdown from "../../../components/Countdown";
import Money from "../../../components/Money";
import FallbackNotice from "../../../components/FallbackNotice";
import TxStatus from "../../../components/TxStatus";
import { button, card, error, mono, nav, ok, page, secondaryButton, warning } from "../../../components/styles";

type Phase = "idle" | "working" | "pending-event" | "funded" | "failed";

function errText(e: unknown): string {
  return e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e);
}

export default function FundPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const rawId = decodeURIComponent(id);
  const view = useDeal(rawId);

  const [account, setAccount] = useState<string | null>(null);
  const [bundle, setBundle] = useState<FundingBundle | null>(null);
  const [bundleError, setBundleError] = useState<string | null>(null);
  const [loadingBundle, setLoadingBundle] = useState(true);

  const [buyerSig, setBuyerSig] = useState<string>("");
  const [sellerSig, setSellerSig] = useState<string>("");
  const [readinessSig, setReadinessSig] = useState<string>("");
  const [allowanceSig, setAllowanceSig] = useState<string>("");
  const [admissionJson, setAdmissionJson] = useState<string>("");

  const [working, setWorking] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [detail, setDetail] = useState<string>("");
  const [failure, setFailure] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [approveTxHash, setApproveTxHash] = useState<string | null>(null);

  const draftId = view.draftId ?? (rawId.startsWith("draft_") ? rawId : null);

  const loadBundle = useCallback(async (idToLoad: string) => {
    setLoadingBundle(true);
    setBundleError(null);
    try {
      const loaded = await fetchFundingBundle(idToLoad);
      setBundle(loaded);
      // The bundle carries signing params, never wallet signatures: prefill
      // only the draft's recorded DealTerms signatures.
      setBuyerSig(loaded.signatures.buyer ?? "");
      setSellerSig(loaded.signatures.seller ?? "");
      setReadinessSig("");
      setAllowanceSig("");
    } catch (e) {
      setBundleError(errText(e));
    } finally {
      setLoadingBundle(false);
    }
  }, []);

  useEffect(() => {
    if (draftId) void loadBundle(draftId);
  }, [draftId, loadBundle]);

  async function connect() {
    setFailure(null);
    try {
      const state = await connectWallet();
      if (state.address) setAccount(state.address);
    } catch (e) {
      setFailure(errText(e));
    }
  }

  async function requireAccount(): Promise<string> {
    if (account) return account;
    const addr = await getAccount();
    setAccount(addr);
    return addr;
  }

  function structSigs() {
    if (!bundle) throw new Error("Funding bundle not loaded");
    return {
      buyer: buyerSig.trim(),
      seller: sellerSig.trim(),
      allowance: allowanceSig.trim(),
      ...(readinessSig.trim() ? { readiness: readinessSig.trim() } : {}),
    };
  }

  async function signAsBuyer() {
    setFailure(null);
    if (!bundle) return;
    try {
      const addr = await requireAccount();
      const sig = await signDealTerms(addr as `0x${string}`, bundle.dealTermsTypedData);
      setBuyerSig(sig);
      setDetail(`Buyer DealTerms signature collected (${sig.slice(0, 12)}…). 32-field MidmanEscrow struct.`);
    } catch (e) {
      setFailure(errText(e));
    }
  }

  async function signReadinessConsent() {
    setFailure(null);
    if (!bundle) return;
    try {
      const addr = await requireAccount();
      if (!bundle.agreementDigest) throw new Error("Bundle is missing agreementDigest");
      const sig = await signReadiness(
        addr as `0x${string}`,
        {
          dealId: bundle.dealId,
          agreementDigest: bundle.agreementDigest,
          buyer: addr as `0x${string}`,
          attestedAt: bundle.readiness.attestedAt,
          nonce: bundle.readiness.nonce,
          expiresAt: bundle.readiness.expiresAt,
        },
        { chainId: bundle.chainId, hub: bundle.hub },
      );
      setReadinessSig(sig);
      setDetail("Readiness consent signed (buyer). Required before short-deadline funding.");
    } catch (e) {
      setFailure(errText(e));
    }
  }

  async function signAllowanceIntentLocal() {
    setFailure(null);
    if (!bundle) return;
    try {
      const addr = await requireAccount();
      if (!bundle.agreementDigest) throw new Error("Bundle is missing agreementDigest");
      const sig = await signAllowance(
        addr as `0x${string}`,
        {
          dealId: bundle.dealId,
          agreementDigest: bundle.agreementDigest,
          payer: addr as `0x${string}`,
          amount: BigInt(bundle.fundedUnits),
          paymentSalt: bundle.allowance.paymentSalt,
          nonce: bundle.allowance.nonce,
          expiresAt: bundle.allowance.expiresAt,
        },
        { chainId: bundle.chainId, hub: bundle.hub },
      );
      setAllowanceSig(sig);
      setDetail("Allowance intent signed. The direct path can now approve + fund().");
    } catch (e) {
      setFailure(errText(e));
    }
  }

  function effectiveSignatures(): { buyer: string; seller: string } {
    return { buyer: buyerSig.trim(), seller: sellerSig.trim() };
  }

  function assertReady(): void {
    const sigs = effectiveSignatures();
    if (!sigs.buyer) throw new Error("Buyer DealTerms signature missing. Sign with the wallet first.");
    if (!sigs.seller) throw new Error("Seller DealTerms signature missing. Paste the seller signature first.");
    if (!bundle) throw new Error("Funding bundle not loaded");
    if (!bundle.admission.granted || bundle.admission.granted.signature === "") {
      throw new Error("Signed admission authorization is missing. Attach the operator-signed admission first.");
    }
    if (bundle.readiness.required === true && (readinessSig === "" || readinessSig === "0x")) {
      throw new Error("This deal requires a readiness consent signature before funding.");
    }
    if (bundle.readiness.required === null) {
      throw new Error("Readiness requirement is unknown for this draft. Refusing to fund.");
    }
    if (allowanceSig === "" || allowanceSig === "0x") {
      throw new Error("Allowance intent signature missing. Sign the allowance intent first.");
    }
  }

  async function submitSignatures() {
    setFailure(null);
    if (!draftId) return;
    try {
      const sigs = effectiveSignatures();
      const payload: { buyer?: string; seller?: string } = {};
      if (sigs.buyer) payload.buyer = sigs.buyer;
      if (sigs.seller) payload.seller = sigs.seller;
      await submitDealSignatures(draftId, payload);
      setDetail("DealTerms signatures recorded on the draft.");
    } catch (e) {
      setFailure(errText(e));
    }
  }

  async function relayFund() {
    setFailure(null);
    setDetail("");
    setWorking(true);
    setPhase("working");
    try {
      if (!draftId) throw new Error("Funding requires a draft id (draft_…)");
      assertReady();
      const addr = await requireAccount();
      if (!bundle) throw new Error("Funding bundle not loaded");
      const relayWallet = getWalletClient();
      await ensureChainId(relayWallet as unknown as { getChainId(): Promise<number> }, bundle.chainId);
      void addr;
      const payload = assembleRelayPayload(bundle, structSigs());
      const result = await submitRelayFund(draftId, payload);
      setPhase("pending-event");
      setDetail(
        `Relay accepted (${result.status}). A relay acceptance is NOT inclusion — waiting for the relayer tx and the DealFunded event…`,
      );
      const confirmed = await waitForFundingEvent(draftId, bundle.hub, bundle.dealId, { intervalMs: 5_000, timeoutMs: 300_000 });
      setTxHash(confirmed.txHash);
      setPhase("funded");
      setDetail(
        `INCLUDED: tx ${confirmed.txHash} succeeded and emitted DealFunded(dealId=${String(
          confirmed.event.args["dealId"],
        )}). Funding is on-chain.`,
      );
    } catch (e) {
      setPhase("failed");
      setFailure(errText(e));
    } finally {
      setWorking(false);
    }
  }

  async function fundDirect() {
    setFailure(null);
    setDetail("");
    setWorking(true);
    setPhase("working");
    try {
      if (!bundle) throw new Error("Funding bundle not loaded");
      assertReady();
      const addr = await requireAccount();
      const wallet = getWalletClient();
      await ensureChainId(wallet as unknown as { getChainId(): Promise<number> }, bundle.chainId);
      setDetail("Submitting ERC20 approve, then fund() — approve alone is not funding.");
      const result = await directFund(bundle, structSigs(), { account: addr as `0x${string}` });
      setApproveTxHash(result.approveTxHash);
      setTxHash(result.fundTxHash);
      setPhase("funded");
      setDetail(
        `INCLUDED: fund() tx ${result.fundTxHash} succeeded and emitted DealFunded(dealId=${String(
          result.event.args["dealId"],
        )}).${result.approveTxHash ? ` (approve tx ${result.approveTxHash})` : ""}`,
      );
    } catch (e) {
      setPhase("failed");
      setFailure(errText(e));
    } finally {
      setWorking(false);
    }
  }

  async function refreshStatus() {
    if (!draftId) return;
    try {
      const status = await fetchFundingStatus(draftId);
      setDetail(
        `Funding status: ${status.status} · level ${status.level} · tx ${status.txHash ?? "(none)"}. ` +
          "The event confirmation above is the only proof of funding.",
      );
    } catch (e) {
      setFailure(errText(e));
    }
  }

  if (view.loading && loadingBundle) {
    return (
      <main style={page}>
        <p>Loading funding panel…</p>
      </main>
    );
  }

  const terms = view.terms;
  const fundedUnits = bundle?.fundedUnits ?? terms?.fundedUnits ?? "0";
  const prepaidUnits = bundle?.prepaidBuyerFeeUnits ?? terms?.prepaidBuyerFeeUnits ?? "0";
  const chainId = bundle?.chainId ?? Number(terms?.chainId ?? CHAIN_ID);
  const token = bundle?.token ?? (terms?.token as `0x${string}` | undefined) ?? USDC_ADDRESS;
  const hub = bundle?.hub ?? ((terms?.hub as `0x${string}` | undefined) ?? HUB_ADDRESS);
  const tokenOk = String(token).toLowerCase() === USDC_ADDRESS.toLowerCase();
  const hubOk = String(HUB_ADDRESS) === "" || String(hub).toLowerCase() === String(HUB_ADDRESS).toLowerCase();
  const chainOk = chainId === CHAIN_ID;
  const bothSigned = Boolean(buyerSig.trim() && sellerSig.trim());
  const admissionReady = Boolean(
    bundle?.admission.granted &&
      bundle.admission.granted.signature !== "" &&
      bundle.admission.granted.signature !== "0x",
  );
  const readinessReady = bundle?.readiness.required !== true || Boolean(readinessSig);
  const allowanceReady = Boolean(allowanceSig);

  if (!draftId && !terms) {
    return (
      <main style={page}>
        <h1>Fund</h1>
        <div style={error}>{view.error ?? "Draft not loaded."}</div>
        <p style={nav}>
          <a href={`/deals/${id}`}>← Dashboard</a>
        </p>
      </main>
    );
  }

  return (
    <main style={page}>
      <h1>Fund</h1>
      <p style={nav}>
        <a href={`/deals/${id}`}>← Dashboard</a>
      </p>

      <div style={card}>
        <h2>
          Exact total: <Money units={fundedUnits} />
        </h2>
        <p>
          Principal <Money units={bundle?.principalUnits ?? terms?.principalUnits ?? "0"} /> + buyer prepaid fee{" "}
          <Money units={prepaidUnits} />. No partial funding: the buyer pays exactly this amount.
        </p>
        {terms?.fundingDeadline ? (
          <p>
            Funding deadline: {formatUnixDate(terms.fundingDeadline)} (<Countdown targetUnix={terms.fundingDeadline} />)
          </p>
        ) : null}
        <p style={{ fontSize: 13 }}>
          32-field MidmanEscrow <code>DealTerms</code> — both buyer and seller must sign this canonical struct, not the
          legacy 5-field draft acceptance.
        </p>
      </div>

      <div style={card}>
        <h2>Wallet</h2>
        {account ? (
          <p>
            Connected: <span style={mono}>{account}</span>
          </p>
        ) : (
          <button type="button" style={button} onClick={() => void connect()}>
            Connect wallet
          </button>
        )}
      </div>

      <div style={card}>
        <h2>Network & token checks</h2>
        <ul>
          <li>
            Deal chain ID: {chainId} {chainOk ? "✓ matches" : `⚠ expected ${CHAIN_ID}`}
          </li>
          <li>
            Deal token: <span style={mono}>{String(token)}</span> {tokenOk ? "✓ matches USDC" : "⚠ DIFFERS from USDC"}
          </li>
          <li>
            Deal hub: <span style={mono}>{String(hub)}</span> {hubOk ? "✓ matches configured hub" : "⚠ DIFFERS from configured hub"}
          </li>
        </ul>
        {!chainOk || !tokenOk || !hubOk ? (
          <div style={error}>Network/token/hub mismatch. Do NOT fund until the deployment is verified.</div>
        ) : null}
      </div>

      {loadingBundle ? <div style={card}>Loading funding bundle…</div> : null}
      {bundleError ? (
        <div style={warning}>
          Funding bundle unavailable: {bundleError}
          <div style={{ marginTop: 8 }}>
            <button type="button" style={secondaryButton} onClick={() => draftId && void loadBundle(draftId)}>
              Retry bundle
            </button>
          </div>
        </div>
      ) : null}

      {bundle ? (
        <>
          <div style={card}>
            <h2>DealTerms signatures (required: buyer + seller)</h2>
            <p style={{ fontSize: 14 }}>
              Buyer signs with the connected wallet; the seller signature is pasted from the seller&apos;s session (or
              collected via the relay endpoint). Both are required for <code>fund()</code>.
            </p>
            <button type="button" style={secondaryButton} onClick={() => void signAsBuyer()} disabled={!account}>
              {buyerSig ? "Re-sign as buyer" : "Sign DealTerms as buyer"}
            </button>
            <button type="button" style={secondaryButton} onClick={() => void submitSignatures()} disabled={!draftId}>
              Record signatures on draft
            </button>
            <p style={{ fontSize: 13 }}>
              buyer: {buyerSig ? `✓ ${buyerSig.slice(0, 14)}…` : "✗"} · seller: {sellerSig ? "✓" : "✗"}
            </p>
            <label style={{ display: "block", fontSize: 14, marginTop: 8 }}>
              Seller DealTerms signature
              <textarea
                value={sellerSig}
                onChange={(e) => setSellerSig(e.target.value)}
                placeholder="0x…"
                style={{ width: "100%", minHeight: 60, padding: 8, boxSizing: "border-box" }}
              />
            </label>
          </div>

          {bundle.readiness.required === true ? (
            <div style={warning}>
              <strong>Readiness consent required (short-delivery deal).</strong> The hub rejects funding unless the
              buyer&apos;s ReadinessConsent signature is attached.
              <div style={{ marginTop: 8 }}>
                <button
                  type="button"
                  style={secondaryButton}
                  onClick={() => void signReadinessConsent()}
                  disabled={!account || !bundle.readiness}
                >
                  {readinessSig ? "Re-sign readiness consent" : "Sign readiness consent"}
                </button>
                <span style={{ fontSize: 13, marginLeft: 8 }}>{readinessReady ? "✓ ready" : "✗ missing"}</span>
              </div>
            </div>
          ) : null}

          <div style={card}>
            <h2>Admission authorization</h2>
            <p style={{ fontSize: 14 }}>
              The hub requires an operator-signed admission. The web never mints admission signatures.
            </p>
            {bundle.admission.granted ? (
              <p style={mono}>
                minPolicyId {bundle.admission.granted.minPolicyId.slice(0, 12)}… · nonce{" "}
                {bundle.admission.granted.admissionNonce.slice(0, 12)}… · expires{" "}
                {String(bundle.admission.granted.expiresAt)} · signature{" "}
                {bundle.admission.granted.signature ? "✓ present" : "✗ missing"}
              </p>
            ) : (
              <div style={warning}>No admission attached to this bundle yet.</div>
            )}
            <p style={{ fontSize: 13 }}>{bundle.admission.note}</p>
            {!admissionReady ? (
              <>
                <textarea
                  value={admissionJson}
                  onChange={(e) => setAdmissionJson(e.target.value)}
                  placeholder='{"minPolicyId":"0x…","admissionNonce":"0x…","expiresAt":"…","signature":"0x…"}'
                  style={{ width: "100%", minHeight: 70, padding: 8, boxSizing: "border-box" }}
                />
                <button
                  type="button"
                  style={secondaryButton}
                  onClick={() => {
                    try {
                      const parsed = JSON.parse(admissionJson) as Record<string, string>;
                      setBundle({
                        ...bundle,
                        admission: {
                          ...bundle.admission,
                          granted: {
                            minPolicyId: parsed.minPolicyId as `0x${string}`,
                            admissionNonce: parsed.admissionNonce as `0x${string}`,
                            expiresAt: BigInt(parsed.expiresAt),
                            signature: parsed.signature,
                          },
                        },
                      });
                      setDetail("Admission authorization attached to the local bundle.");
                    } catch (e) {
                      setFailure(errText(e));
                    }
                  }}
                >
                  Attach admission
                </button>
              </>
            ) : (
              <span style={{ fontSize: 13 }}>✓ admission ready</span>
            )}
          </div>

          <div style={card}>
            <h2>Allowance intent</h2>
            <p style={{ fontSize: 14 }}>
              Both funding paths need a FundWithAllowance signature for the exact amount. Sign it with the buyer
              wallet after connecting.
            </p>
            <button type="button" style={secondaryButton} onClick={() => void signAllowanceIntentLocal()} disabled={!account}>
              {allowanceSig ? "Re-sign allowance intent" : "Sign allowance intent"}
            </button>
            <span style={{ fontSize: 13, marginLeft: 8 }}>{allowanceReady ? "✓ ready" : "✗ missing"}</span>
          </div>

          <div style={card}>
            <h2>Submit funding</h2>
            <p style={{ fontSize: 13 }}>
              Both paths finish only after the exact transaction receipt succeeds AND the <code>DealFunded</code> event
              for this dealId is confirmed.
            </p>
            <button type="button" style={button} disabled={working || !bothSigned || !admissionReady || !readinessReady} onClick={() => void relayFund()}>
              {working && phase === "working" ? "Working…" : "Sponsored relay: fund"}
            </button>
            <button
              type="button"
              style={secondaryButton}
              disabled={working || !bothSigned || !admissionReady || !readinessReady}
              onClick={() => void fundDirect()}
            >
              Direct: approve + fund()
            </button>
            <button type="button" style={secondaryButton} onClick={() => void refreshStatus()}>
              Refresh funding status
            </button>
            {!bothSigned ? <div style={warning}>Buyer and seller DealTerms signatures are required.</div> : null}
            {!admissionReady ? <div style={warning}>Operator-signed admission is required.</div> : null}
            {!readinessReady ? <div style={warning}>Readiness consent signature is required.</div> : null}
          </div>
        </>
      ) : null}

      {phase === "pending-event" ? (
        <div style={card}>
          <p>
            <TxStatus level="pending" txHash={txHash} />
          </p>
          <p style={{ fontSize: 13 }}>Relay accepted. Not funded until the DealFunded event is confirmed.</p>
        </div>
      ) : null}

      {phase === "funded" ? (
        <div style={ok}>
          <p>
            <strong>Funded — DealFunded confirmed.</strong> <TxStatus level="included" txHash={txHash} />
          </p>
          <p style={mono}>fund tx: {txHash}</p>
          {approveTxHash ? <p style={mono}>approve tx: {approveTxHash}</p> : null}
        </div>
      ) : null}

      {detail ? <p style={{ fontSize: 14 }}>{detail}</p> : null}
      {failure ? <div style={error}>{failure}</div> : null}
      {phase === "failed" ? (
        <button type="button" style={secondaryButton} onClick={() => setPhase("idle")}>
          Back
        </button>
      ) : null}

      {view.dealId ? <FallbackNotice dealId={view.dealId} /> : null}
    </main>
  );
}
