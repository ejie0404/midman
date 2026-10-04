"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import { hashTypedData } from "viem";
import { ApiError, relaySubmit } from "../../../lib/api";
import type { RequestSigner } from "../../../lib/requestAuth";
import {
  FALLBACK_PANEL_COPY,
  REVIEW_MISSING_COPY,
  REVIEWER_DENIED_COPY,
  REVIEWER_SIGNING_COPY,
  VETO_CANCEL_ONLY_COPY,
  buildRulingTypedData,
  buildVetoTypedData,
  fetchReviewCase,
  isReviewMissing,
  isReviewerDenied,
  isReviewCaseBundle,
  normalizeTypedDataMessage,
  postApproval,
  postAssignReviewers,
  postAwardDraft,
  postQueueRuling,
  postRecusal,
  postVeto,
  previewAward,
  quorumProgress,
  relayKeyOf,
  signTypedDataWithWallet,
  type AwardDraftResult,
  type ReviewCaseBundle,
  type VetoSigInput,
} from "../../../lib/review";
import { formatUSDC, parseUSDC } from "../../../lib/money";
import { CHAIN_ID, HUB_ADDRESS, getAccount, getWalletClient, randomBytes32, sendDirect } from "../../../lib/wallet";
import { connectEvidenceAuth } from "../../components/evidenceAuth";
import Countdown from "../../components/Countdown";
import Money from "../../components/Money";
import { button, card, dangerButton, error, mono, nav, ok, page, secondaryButton, warning } from "../../components/styles";

type LoadStatus = "connect" | "loading" | "ready" | "missing" | "denied" | "error";

const VETO_REASONS: readonly string[] = [
  "quorum-failure",
  "evidence-mismatch",
  "policy-violation",
  "expired-queue",
  "other",
];

function shortHash(hash: string): string {
  return hash.length <= 18 ? hash : `${hash.slice(0, 10)}…${hash.slice(-8)}`;
}

function asUnits(value: string | undefined, fallback: string): string {
  if (!value || !/^\d+$/.test(value.trim())) return fallback;
  return value.trim();
}

export default function ReviewCasePage({ params }: { params: Promise<{ dealId: string }> }) {
  const dealId = decodeURIComponent(use(params).dealId);
  const [status, setStatus] = useState<LoadStatus>("connect");
  const [auth, setAuth] = useState<RequestSigner | null>(null);
  const [bundle, setBundle] = useState<ReviewCaseBundle | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  // Award builder state.
  const [awardUsdc, setAwardUsdc] = useState("");
  const [commitment, setCommitment] = useState("");
  const [draft, setDraft] = useState<AwardDraftResult | null>(null);

  // Veto assembly state (UI-side justification + collected authority sigs).
  const [vetoReason, setVetoReason] = useState<string>(VETO_REASONS[0] ?? "other");
  const [vsigs, setVsigs] = useState<readonly VetoSigInput[]>([]);

  // Assignment + recusal state.
  const [primaryRoster, setPrimaryRoster] = useState("");
  const [fallbackRoster, setFallbackRoster] = useState("");
  const [recusalReason, setRecusalReason] = useState("");

  const load = useCallback(
    async (signer: RequestSigner) => {
      setStatus("loading");
      setLoadError(null);
      try {
        const result = await fetchReviewCase(dealId, signer);
        if (!isReviewCaseBundle(result)) throw new Error("Review backend returned an unrecognized case shape.");
        setBundle(result);
        const head = result.evidence.head;
        setCommitment((prev) => prev || head || result.evidence.manifest[0]?.fileHash || "");
        setStatus("ready");
      } catch (e) {
        if (isReviewMissing(e)) setStatus("missing");
        else if (isReviewerDenied(e)) setStatus("denied");
        else {
          setStatus("error");
          setLoadError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
        }
      }
    },
    [dealId],
  );

  async function connect() {
    setFailure(null);
    try {
      const signer = await connectEvidenceAuth();
      setAuth(signer);
      await load(signer);
    } catch (e) {
      setStatus("error");
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }

  const deal = bundle?.deal ?? {};
  const principalUnits = asUnits(deal["principal"], "0");
  const quotedFeeUnits = asUnits(deal["quotedFee"], "0");
  const buyerFeeBps = deal["buyerFeeBps"] === "0" ? 0 : deal["buyerFeeBps"] === "10000" ? 10000 : 5000;
  const claimantBond = asUnits(deal["claimantBond"] ?? deal["claimantBondUnits"], "5000000");
  const respondentBond = asUnits(deal["respondentBond"] ?? deal["respondentBondUnits"], "5000000");
  const phase = deal["phase"] ?? "";
  const isFallback = phase === "FALLBACK_REVIEW" || phase === "RULING_PENDING";
  const need = bundle?.approvals.need ?? (isFallback ? (bundle?.quorum.fallback ?? 0) : (bundle?.quorum.primary ?? 0)) ?? 0;

  const awardPreview = useMemo(() => {
    if (!bundle || principalUnits === "0" || awardUsdc.trim() === "") return null;
    try {
      const units = parseUSDC(awardUsdc);
      return previewAward({
        principalUnits,
        quotedFeeUnits,
        buyerFeeBps: buyerFeeBps as 0 | 5000 | 10000,
        sellerAwardUnits: units,
        claimantBondUnits: claimantBond,
        respondentBondUnits: respondentBond,
      });
    } catch {
      return null;
    }
  }, [bundle, principalUnits, quotedFeeUnits, buyerFeeBps, awardUsdc, claimantBond, respondentBond]);

  const quorum = useMemo(() => {
    const signers = (bundle?.approvals.signers ?? []).map((s) => s.signer);
    const recused = (bundle?.recusals ?? []).map((r) => r.reviewer);
    return quorumProgress(signers, recused, need);
  }, [bundle, need]);

  const rulingDigest = useMemo(() => {
    if (!draft) return null;
    try {
      const message = normalizeTypedDataMessage(draft.typedData);
      const digest = hashTypedData({
        domain: draft.typedData.domain as never,
        types: draft.typedData.types as never,
        primaryType: draft.typedData.primaryType as never,
        message: message as never,
      } as never);
      return digest as string;
    } catch {
      return null;
    }
  }, [draft]);

  async function signWithWallet(message: Record<string, unknown>, envelope: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
  }): Promise<{ account: string; signature: string }> {
    const account = await getAccount();
    const client = getWalletClient();
    const signature = await signTypedDataWithWallet(
      { signTypedData: (args) => (client.signTypedData as (a: unknown) => Promise<string>)(args) },
      account,
      { ...envelope, message },
    );
    return { account, signature };
  }

  async function draftAward() {
    if (!auth || !bundle) return;
    setWorking(true);
    setNotice(null);
    setFailure(null);
    try {
      if (awardUsdc.trim() === "") throw new Error("Enter the seller award S in USDC.");
      const sellerAwardUnits = parseUSDC(awardUsdc);
      if (BigInt(sellerAwardUnits) > BigInt(principalUnits)) {
        throw new Error(`Award exceeds principal (${formatUSDC(principalUnits)}). Awards are bounded to [0, P].`);
      }
      if (!commitment) throw new Error("Pick an evidence commitment from the manifest.");
      const result = await postAwardDraft(dealId, { sellerAwardUnits, evidenceCommitment: commitment }, auth);
      setDraft(result);
      setNotice(`Award drafted (nonce ${shortHash(result.rulingNonce)}). Review the typed-data, then sign-and-submit below.`);
    } catch (e) {
      setFailure(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  }

  async function signAndApprove() {
    if (!auth || !draft) return;
    setWorking(true);
    setNotice(null);
    setFailure(null);
    try {
      const message = normalizeTypedDataMessage(draft.typedData);
      // Client checks mirror the contract: distinct signer + recusal exclusion.
      const account = await getAccount();
      const recused = new Set((bundle?.recusals ?? []).map((r) => r.reviewer.toLowerCase()));
      if (recused.has(account.toLowerCase())) throw new Error("You recused from this case — recused reviewers cannot approve.");
      const already = new Set((bundle?.approvals.signers ?? []).map((s) => s.signer.toLowerCase()));
      if (already.has(account.toLowerCase())) throw new Error("This wallet already approved — duplicate signatures do not count.");
      const { signature } = await signWithWallet(message, draft.typedData);
      const digest =
        rulingDigest ??
        (() => {
          // Fallback: rebuild from known fields when the digest helper failed.
          const rebuilt = buildRulingTypedData({
            chainId: Number(deal["chainId"] ?? CHAIN_ID),
            hub: (deal["hub"] ?? HUB_ADDRESS) as string,
            dealId,
            agreementDigest: (deal["termsHash"] ?? deal["agreementDigest"] ?? dealId) as string,
            arbitrationPolicyId: (deal["arbitrationPolicyId"] ?? dealId) as string,
            origin: isFallback ? 1 : 0,
            rulingNonce: draft.rulingNonce,
            sellerAwardUnits: draft.award.sellerAwardUnits,
            buyerCostUnits: draft.award.buyerCostUnits,
            sellerCostUnits: draft.award.sellerCostUnits,
            evidenceCommitment: draft.award.evidenceCommitment,
            authEpoch: draft.award.authEpoch,
            queueExpiry: draft.award.queueExpiry,
          });
          const m = normalizeTypedDataMessage(rebuilt);
          return hashTypedData({
            domain: rebuilt.domain as never,
            types: rebuilt.types as never,
            primaryType: rebuilt.primaryType as never,
            message: m as never,
          } as never) as string;
        })();
      const result = await postApproval(dealId, { signer: account, signature, rulingDigest: digest }, auth);
      setNotice(`Approval recorded: ${result.have}/${result.need}${result.complete ? " — quorum complete, queue the ruling." : "."}`);
      await load(auth);
    } catch (e) {
      setFailure(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  }

  async function queueRuling(direct: boolean) {
    if (!auth || !bundle) return;
    setWorking(true);
    setNotice(null);
    setFailure(null);
    try {
      const awardId = draft?.award.id ?? bundle.awards[0]?.id;
      if (!awardId) throw new Error("Draft an award first — there is nothing to queue.");
      const result = await postQueueRuling(dealId, awardId, auth);
      if (direct) {
        const hub = ((deal["hub"] ?? HUB_ADDRESS) as string) as `0x${string}`;
        const hash = await sendDirect(hub, result.calldata as `0x${string}`);
        setNotice(`Direct queue-ruling sent (${hash}) — pending until included.`);
      } else {
        const payload = result.relayPayload;
        const res = await relaySubmit(relayKeyOf(payload), payload.action, payload.params);
        setNotice(`Relay ${res.status} (key ${res.idempotencyKey}) — pending until included.`);
      }
    } catch (e) {
      setFailure(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  }

  async function collectVetoSig() {
    setWorking(true);
    setNotice(null);
    setFailure(null);
    try {
      const digest =
        rulingDigest ?? (bundle?.awards[0] as unknown as { rulingDigest?: string } | undefined)?.rulingDigest;
      if (!digest) throw new Error("No ruling digest yet — draft (or select) an award before assembling veto signatures.");
      const account = await getAccount();
      if (vsigs.some((v) => v.authority.toLowerCase() === account.toLowerCase())) {
        throw new Error("This authority already signed — veto needs distinct authorities.");
      }
      const envelope = buildVetoTypedData({
        chainId: Number(deal["chainId"] ?? CHAIN_ID),
        hub: (deal["hub"] ?? HUB_ADDRESS) as string,
        dealId,
        rulingDigest: digest,
        authority: account,
        nonce: randomBytes32(),
        expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
      });
      const { signature } = await signWithWallet(normalizeTypedDataMessage(envelope), envelope);
      setVsigs((prev) => [
        ...prev,
        {
          authority: account,
          nonce: String(envelope.message["nonce"]),
          expiry: String(envelope.message["expiresAt"]),
          signature,
        },
      ]);
      setNotice(`Veto signature ${vsigs.length + 1} collected from ${shortHash(account)} (reason: ${vetoReason}, UI-only).`);
    } catch (e) {
      setFailure(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  }

  async function submitVeto(direct: boolean) {
    if (!auth) return;
    setWorking(true);
    setNotice(null);
    setFailure(null);
    try {
      if (vsigs.length < 2) throw new Error("Veto needs at least 2 distinct authority signatures (VETO_QUORUM).");
      const digest =
        rulingDigest ?? (bundle?.awards[0] as unknown as { rulingDigest?: string } | undefined)?.rulingDigest;
      if (!digest) throw new Error("No ruling digest — cannot veto.");
      const result = await postVeto(dealId, { rulingDigest: digest, vsigs }, auth);
      if (direct) {
        const hub = ((deal["hub"] ?? HUB_ADDRESS) as string) as `0x${string}`;
        const hash = await sendDirect(hub, result.calldata as `0x${string}`);
        setNotice(`Direct veto sent (${hash}) — pending until included. The ruling is cancelled, not replaced.`);
      } else {
        const payload = result.relayPayload;
        const res = await relaySubmit(relayKeyOf(payload), payload.action, payload.params);
        setNotice(`Relay ${res.status} (key ${res.idempotencyKey}) — pending until included.`);
      }
      setVsigs([]);
    } catch (e) {
      setFailure(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  }

  async function assign() {
    if (!auth) return;
    setWorking(true);
    setNotice(null);
    setFailure(null);
    try {
      const split = (text: string) =>
        text.split(/[\s,]+/).map((s) => s.trim()).filter((s) => /^0x[0-9a-fA-F]{40}$/.test(s));
      const primary = split(primaryRoster);
      const fallback = split(fallbackRoster);
      if (primary.length === 0 && fallback.length === 0) throw new Error("Enter at least one 0x reviewer address.");
      await postAssignReviewers(dealId, { primary, fallback }, auth);
      setNotice(`Rosters assigned: ${primary.length} primary, ${fallback.length} fallback.`);
    } catch (e) {
      setFailure(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  }

  async function recuse() {
    if (!auth) return;
    setWorking(true);
    setNotice(null);
    setFailure(null);
    try {
      if (recusalReason.trim() === "") throw new Error("A recusal reason is required.");
      const reviewer = await getAccount();
      await postRecusal(dealId, { reviewer, reason: recusalReason.trim() }, auth);
      setNotice("Recusal recorded — you can no longer approve on this case.");
      await load(auth);
    } catch (e) {
      setFailure(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  }

  useEffect(() => {
    // Keep the evidence-commitment picker valid when the bundle reloads.
    if (bundle && !commitment) {
      setCommitment(bundle.evidence.head || bundle.evidence.manifest[0]?.fileHash || "");
    }
  }, [bundle, commitment]);

  if (status === "connect") {
    return (
      <main style={page}>
        <h1>Case workspace</h1>
        <p style={nav}>
          <a href="/review">← Queue</a>
        </p>
        <div style={card}>
          <h2>Connect a reviewer wallet</h2>
          <p style={{ fontSize: 14 }}>{REVIEWER_SIGNING_COPY}</p>
          <button type="button" style={button} onClick={() => void connect()}>
            Connect reviewer wallet
          </button>
        </div>
      </main>
    );
  }
  if (status === "loading") {
    return (
      <main style={page}>
        <p>Loading case {dealId}…</p>
      </main>
    );
  }
  if (status === "missing") {
    return (
      <main style={page}>
        <h1>Case workspace</h1>
        <p style={nav}>
          <a href="/review">← Queue</a>
        </p>
        <div style={warning}>{REVIEW_MISSING_COPY}</div>
        {auth ? (
          <button type="button" style={secondaryButton} onClick={() => void load(auth)}>
            Retry
          </button>
        ) : null}
      </main>
    );
  }
  if (status === "denied") {
    return (
      <main style={page}>
        <h1>Case workspace</h1>
        <p style={nav}>
          <a href="/review">← Queue</a>
        </p>
        <div style={warning}>{REVIEWER_DENIED_COPY}</div>
      </main>
    );
  }
  if (status === "error" || !bundle) {
    return (
      <main style={page}>
        <h1>Case workspace</h1>
        <p style={nav}>
          <a href="/review">← Queue</a>
        </p>
        <div style={error}>{loadError ?? "Case failed to load."}</div>
        {auth ? (
          <button type="button" style={secondaryButton} onClick={() => void load(auth)}>
            Retry
          </button>
        ) : null}
      </main>
    );
  }

  return (
    <main style={page}>
      <h1>Case workspace</h1>
      <p style={nav}>
        <a href="/review">← Queue</a>
        {" · "}
        <a href={`/deals/${dealId}`}>Deal dashboard</a>
      </p>

      <div style={card}>
        <h2>
          Deal <span style={mono}>{dealId}</span> · phase {phase || "—"}
          {isFallback ? " · FALLBACK panel (independent roster)" : " · PRIMARY panel"}
        </h2>
        <p style={{ fontSize: 14 }}>{FALLBACK_PANEL_COPY}</p>
        <ul style={{ fontSize: 14 }}>
          {Object.entries(deal).map(([key, value]) => (
            <li key={key}>
              {key}: <span style={mono}>{value}</span>
            </li>
          ))}
        </ul>
      </div>

      <div style={card}>
        <h2>Evidence manifest (read-only)</h2>
        <p style={{ fontSize: 14 }}>
          Head: <span style={mono}>{bundle.evidence.head || "—"}</span> ·{" "}
          <a href={`/deals/${dealId}`}>Messages live on the deal dashboard</a>
        </p>
        {bundle.evidence.manifest.length === 0 ? (
          <p style={{ fontSize: 14 }}>Manifest is empty.</p>
        ) : (
          <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Seq</th>
                <th style={{ textAlign: "left" }}>File hash</th>
                <th style={{ textAlign: "left" }}>Kind</th>
                <th style={{ textAlign: "left" }}>Uploader</th>
                <th style={{ textAlign: "left" }}>Uploaded</th>
              </tr>
            </thead>
            <tbody>
              {bundle.evidence.manifest.map((entry) => (
                <tr key={entry.seq}>
                  <td>{entry.seq}</td>
                  <td style={mono}>{shortHash(entry.fileHash)}</td>
                  <td>{entry.kind}</td>
                  <td style={mono}>{shortHash(entry.uploader)}</td>
                  <td>{entry.uploadedAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div style={card}>
        <h2>Delivery form (read-only)</h2>
        <pre style={{ ...mono, whiteSpace: "pre-wrap" }}>{JSON.stringify(bundle.deliveryForm ?? {}, null, 2)}</pre>
      </div>

      <div style={card}>
        <h2>Award builder</h2>
        <p style={{ fontSize: 14 }}>
          Principal: {principalUnits === "0" ? "unknown (deal field missing)" : <Money units={principalUnits} />} ·
          Quoted fee: <Money units={quotedFeeUnits} />
        </p>
        <label style={{ display: "block", fontSize: 14 }}>
          Seller award S (USDC, bounded to [0, P]):
          <input
            value={awardUsdc}
            onChange={(e) => setAwardUsdc(e.target.value)}
            placeholder="e.g. 70"
            inputMode="decimal"
            style={{ width: "100%", padding: 8, boxSizing: "border-box" }}
          />
        </label>
        <label style={{ display: "block", fontSize: 14, marginTop: 8 }}>
          Evidence commitment (from manifest):
          <select
            value={commitment}
            onChange={(e) => setCommitment(e.target.value)}
            style={{ width: "100%", padding: 8 }}
          >
            <option value="">— pick —</option>
            {bundle.evidence.head ? <option value={bundle.evidence.head}>head {shortHash(bundle.evidence.head)}</option> : null}
            {bundle.evidence.manifest.map((entry) => (
              <option key={entry.seq} value={entry.fileHash}>
                #{entry.seq} {shortHash(entry.fileHash)} ({entry.kind})
              </option>
            ))}
          </select>
        </label>
        {awardPreview ? (
          <div style={ok}>
            <ul style={{ fontSize: 14, margin: 0 }}>
              <li>
                Seller claim <Money units={awardPreview.sellerClaimUnits} /> · Buyer claim{" "}
                <Money units={awardPreview.buyerClaimUnits} /> · Earned fee{" "}
                <Money units={awardPreview.earnedFeeUnits} />
              </li>
              <li>
                Bond costs — buyer <Money units={awardPreview.buyerCostUnits} /> · seller{" "}
                <Money units={awardPreview.sellerCostUnits} /> (exact P-03 derivation)
              </li>
            </ul>
          </div>
        ) : (
          <p style={{ fontSize: 14 }}>Enter S in USDC to see the exact-unit preview (fee split + bond costs).</p>
        )}
        <button type="button" style={button} disabled={working || !auth} onClick={() => void draftAward()}>
          Draft award
        </button>
        {draft ? (
          <div style={ok}>
            <p style={{ fontSize: 14 }}>
              Drafted: award <span style={mono}>{draft.award.id}</span> · S ={" "}
              <Money units={draft.award.sellerAwardUnits} /> · nonce <span style={mono}>{shortHash(draft.rulingNonce)}</span>
            </p>
            <pre style={{ ...mono, whiteSpace: "pre-wrap" }}>{JSON.stringify(draft.typedData, null, 2)}</pre>
          </div>
        ) : null}
      </div>

      <div style={card}>
        <h2>
          Approvals ({quorum.have}/{quorum.need}
          {quorum.complete ? " — quorum complete ✓" : ""})
        </h2>
        <p style={{ fontSize: 14 }}>{REVIEWER_SIGNING_COPY}</p>
        <ul style={{ fontSize: 14 }}>
          {bundle.approvals.signers.map((s) => (
            <li key={`${s.signer}-${s.signature.slice(0, 18)}`}>
              <span style={mono}>{shortHash(s.signer)}</span> · sig <span style={mono}>{shortHash(s.signature)}</span>
            </li>
          ))}
          {bundle.approvals.signers.length === 0 ? <li>No approvals yet.</li> : null}
        </ul>
        {quorum.excludedRecused > 0 ? (
          <p style={{ fontSize: 14 }}>Excluded {quorum.excludedRecused} recused signature(s).</p>
        ) : null}
        {quorum.excludedDuplicates > 0 ? (
          <p style={{ fontSize: 14 }}>Excluded {quorum.excludedDuplicates} duplicate signature(s).</p>
        ) : null}
        <button type="button" style={button} disabled={working || !draft} onClick={() => void signAndApprove()}>
          Sign typed-data & submit approval
        </button>
        {quorum.complete || (draft && need > 0 && quorum.have + 1 >= need) ? (
          <div style={warning}>
            {quorum.complete
              ? "Quorum is complete — queue the ruling."
              : "Your signature would complete quorum — after submitting above, queue the ruling."}
            <div>
              <button type="button" style={button} disabled={working} onClick={() => void queueRuling(false)}>
                Queue ruling via relay
              </button>
              <button type="button" style={secondaryButton} disabled={working} onClick={() => void queueRuling(true)}>
                Queue ruling direct (wallet send)
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <div style={card}>
        <h2>Veto (cancel-only)</h2>
        <p style={{ fontSize: 14 }}>{VETO_CANCEL_ONLY_COPY}</p>
        <label style={{ display: "block", fontSize: 14 }}>
          Reason code (UI justification only — NOT sent on-chain; the VetoRuling carries no award or recipient):
          <select value={vetoReason} onChange={(e) => setVetoReason(e.target.value)} style={{ width: "100%", padding: 8 }}>
            {VETO_REASONS.map((reason) => (
              <option key={reason} value={reason}>
                {reason}
              </option>
            ))}
          </select>
        </label>
        <p style={{ fontSize: 14 }}>
          Collected {vsigs.length}/2 authority signatures:
          {vsigs.map((v) => (
            <span key={v.nonce} style={mono}>
              {" "}
              {shortHash(v.authority)}
            </span>
          ))}
        </p>
        <button type="button" style={secondaryButton} disabled={working} onClick={() => void collectVetoSig()}>
          Sign veto as connected authority
        </button>
        <div>
          <button type="button" style={dangerButton} disabled={working || vsigs.length < 2} onClick={() => void submitVeto(false)}>
            Submit veto via relay
          </button>
          <button type="button" style={secondaryButton} disabled={working || vsigs.length < 2} onClick={() => void submitVeto(true)}>
            Submit veto direct
          </button>
        </div>
      </div>

      <div style={card}>
        <h2>Assign rosters (separate panels)</h2>
        <p style={{ fontSize: 14 }}>
          Quorum — primary {bundle.quorum.primary}, fallback {bundle.quorum.fallback}, tier {bundle.quorum.tier}.
          Primary and fallback are independent rosters.
        </p>
        <label style={{ display: "block", fontSize: 14 }}>
          Primary reviewers (0x addresses, comma/space separated):
          <input
            value={primaryRoster}
            onChange={(e) => setPrimaryRoster(e.target.value)}
            style={{ width: "100%", padding: 8, boxSizing: "border-box" }}
          />
        </label>
        <label style={{ display: "block", fontSize: 14, marginTop: 8 }}>
          Fallback reviewers (independent roster):
          <input
            value={fallbackRoster}
            onChange={(e) => setFallbackRoster(e.target.value)}
            style={{ width: "100%", padding: 8, boxSizing: "border-box" }}
          />
        </label>
        <button type="button" style={secondaryButton} disabled={working} onClick={() => void assign()}>
          Assign rosters
        </button>
      </div>

      <div style={card}>
        <h2>Recuse</h2>
        <p style={{ fontSize: 14 }}>Recused reviewers are excluded from quorum math and cannot approve.</p>
        <input
          value={recusalReason}
          onChange={(e) => setRecusalReason(e.target.value)}
          placeholder="Reason (required)"
          style={{ width: "100%", padding: 8, boxSizing: "border-box" }}
        />
        <button type="button" style={secondaryButton} disabled={working} onClick={() => void recuse()}>
          Recuse connected wallet
        </button>
        <ul style={{ fontSize: 14 }}>
          {bundle.recusals.map((r) => (
            <li key={r.reviewer}>
              <span style={mono}>{shortHash(r.reviewer)}</span>: {r.reason}
            </li>
          ))}
        </ul>
      </div>

      <div style={card}>
        <h2>Audit trail</h2>
        <ul style={{ fontSize: 14 }}>
          {bundle.awards.map((award) => (
            <li key={award.id}>
              Award <span style={mono}>{award.id}</span>: S = <Money units={award.sellerAwardUnits} />, buyer cost{" "}
              <Money units={award.buyerCostUnits} />, seller cost <Money units={award.sellerCostUnits} />, commitment{" "}
              <span style={mono}>{shortHash(award.evidenceCommitment)}</span>
            </li>
          ))}
          {bundle.awards.length === 0 ? <li>No awards drafted.</li> : null}
          {bundle.approvals.signers.map((s) => (
            <li key={`approval-${s.signer}-${s.signature.slice(0, 18)}`}>
              Approval by <span style={mono}>{s.signer}</span>
            </li>
          ))}
          {bundle.recusals.map((r) => (
            <li key={`recusal-${r.reviewer}`}>
              Recusal by <span style={mono}>{r.reviewer}</span>: {r.reason}
            </li>
          ))}
        </ul>
      </div>

      {notice ? <div style={ok}>{notice}</div> : null}
      {failure ? <div style={error}>{failure}</div> : null}
      {auth ? (
        <button type="button" style={secondaryButton} onClick={() => void load(auth)}>
          Reload case
        </button>
      ) : null}
    </main>
  );
}
