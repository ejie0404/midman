"use client";

// Fund the escrow, as a checklist the buyer works down:
//   1. both parties signed the terms (review page),
//   2. funding approval from Midman (automated admission),
//   3. enough USDC, and the escrow allowed to take it (ERC-20 approve),
//   4. sign the deposit authorization (+ readiness consent for <=3h deals),
//   5. deposit: relayed (we pay the gas for fund()) or sent from the wallet.
// Only the DealFunded event counts as funded; a relay acceptance does not.

import { use, useCallback, useEffect, useState } from "react";
import { erc20Abi, type Address, type Hash } from "viem";
import { requestAdmission } from "../../../../lib/api";
import { ensureChainId, getAccount, getPublicClient, getWalletClient, sendDirect, waitForInclusion } from "../../../../lib/wallet";
import {
  assembleRelayPayload,
  buildApproveCalldata,
  directFund,
  fetchFundingBundle,
  signAllowance,
  signReadiness,
  submitRelayFund,
  waitForFundingEvent,
  type FundingBundle,
} from "../../../../lib/funding";
import { formatAmount } from "../../../../lib/money";
import { friendlyError } from "../../../../lib/errors";
import { useDeal } from "../../../components/useDeal";
import { useSession } from "../../../components/useSession";
import DealShell, { chainPhaseOf, roleOf } from "../../../components/DealShell";
import { Button, ButtonLink, Callout, Card, Chip, Icon } from "../../../components/ui";

const EXPLORER = process.env["NEXT_PUBLIC_EXPLORER_URL"] ?? "https://basescan.org";

type StepState = "done" | "current" | "todo";

function Step({
  n,
  state,
  title,
  children,
}: {
  n: number;
  state: StepState;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <li style={{ display: "grid", gridTemplateColumns: "32px 1fr", gap: 12, padding: "14px 0", borderBottom: "1px solid var(--border)" }}>
      <span
        className="num-badge"
        style={{
          width: 28,
          height: 28,
          borderRadius: "50%",
          display: "grid",
          placeItems: "center",
          fontSize: 13,
          fontWeight: 600,
          background: state === "done" ? "var(--success-soft)" : state === "current" ? "var(--primary)" : "var(--surface-2)",
          color: state === "done" ? "var(--success)" : state === "current" ? "var(--on-primary)" : "var(--subtle)",
        }}
      >
        {state === "done" ? <Icon name="check" size={14} /> : n}
      </span>
      <div style={{ opacity: state === "todo" ? 0.6 : 1 }}>
        <div style={{ fontWeight: 600, marginTop: 3 }}>{title}</div>
        {state === "current" && children ? <div style={{ marginTop: 10 }}>{children}</div> : null}
      </div>
    </li>
  );
}

export default function FundPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = use(params);
  const id = decodeURIComponent(rawId);
  const view = useDeal(id);
  const { session, ensureWallet } = useSession();
  const [bundle, setBundle] = useState<FundingBundle | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [allowance, setAllowance] = useState<bigint | null>(null);
  const [depositSig, setDepositSig] = useState("");
  const [readinessSig, setReadinessSig] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [fundedTx, setFundedTx] = useState<Hash | null>(null);
  const [pendingNote, setPendingNote] = useState<string | null>(null);

  const draftId = view.draftId ?? (id.startsWith("draft_") ? id : null);
  const role = roleOf(view, session?.wallet);
  const alreadyFunded = chainPhaseOf(view) !== null;

  const loadBundle = useCallback(async () => {
    if (!draftId || role !== "buyer") return;
    try {
      setBundle(await fetchFundingBundle(draftId));
    } catch (e) {
      setFailure(friendlyError(e));
    }
  }, [draftId, role]);

  const loadToken = useCallback(async () => {
    if (!bundle || !session) return;
    try {
      const client = getPublicClient();
      const owner = session.wallet as Address;
      const [bal, allow] = await Promise.all([
        client.readContract({ address: bundle.token, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
        client.readContract({ address: bundle.token, abi: erc20Abi, functionName: "allowance", args: [owner, bundle.hub] }),
      ]);
      setBalance(bal);
      setAllowance(allow);
    } catch {
      setBalance(null);
      setAllowance(null);
    }
  }, [bundle, session]);

  useEffect(() => {
    void loadBundle();
  }, [loadBundle]);
  useEffect(() => {
    void loadToken();
  }, [loadToken]);

  async function run(label: string, action: () => Promise<void>) {
    setBusy(label);
    setFailure(null);
    try {
      await action();
    } catch (e) {
      setFailure(friendlyError(e));
    } finally {
      setBusy(null);
    }
  }

  const funded = bundle ? BigInt(bundle.fundedUnits) : 0n;
  const signed = Boolean(bundle?.signatures.buyer && bundle?.signatures.seller);
  const approved = Boolean(bundle?.admission.granted?.signature);
  const enoughUsdc = balance !== null && balance >= funded;
  const allowanceOk = allowance !== null && allowance >= funded;
  const readinessNeeded = bundle?.readiness.required === true;
  const authorized = Boolean(depositSig) && (!readinessNeeded || Boolean(readinessSig));

  const steps: StepState[] = (() => {
    const done = [signed, approved, enoughUsdc && allowanceOk, authorized, Boolean(fundedTx)];
    const firstOpen = done.findIndex((d) => !d);
    return done.map((d, i) => (d ? "done" : i === firstOpen ? "current" : "todo"));
  })();

  async function getApproval() {
    if (!draftId) return;
    await requestAdmission(draftId);
    await loadBundle();
  }

  async function approveToken() {
    if (!bundle) return;
    await ensureWallet();
    const wallet = getWalletClient();
    await ensureChainId(wallet as unknown as { getChainId(): Promise<number> }, bundle.chainId);
    const hash = await sendDirect(bundle.token, buildApproveCalldata(bundle.hub, bundle.fundedUnits));
    setPendingNote("Waiting for the approval to be included…");
    await waitForInclusion(hash);
    setPendingNote(null);
    await loadToken();
  }

  async function authorize() {
    if (!bundle || !bundle.agreementDigest) throw new Error("Deal data is incomplete. Reload the page.");
    await ensureWallet();
    const account = (await getAccount()) as Address;
    const ctx = { chainId: bundle.chainId, hub: bundle.hub };
    if (readinessNeeded) {
      setReadinessSig(
        await signReadiness(
          account,
          {
            dealId: bundle.dealId,
            agreementDigest: bundle.agreementDigest,
            buyer: account,
            attestedAt: bundle.readiness.attestedAt,
            nonce: bundle.readiness.nonce,
            expiresAt: bundle.readiness.expiresAt,
          },
          ctx,
        ),
      );
    }
    setDepositSig(
      await signAllowance(
        account,
        {
          dealId: bundle.dealId,
          agreementDigest: bundle.agreementDigest,
          payer: account,
          amount: funded,
          paymentSalt: bundle.allowance.paymentSalt,
          nonce: bundle.allowance.nonce,
          expiresAt: bundle.allowance.expiresAt,
        },
        ctx,
      ),
    );
  }

  function sigs() {
    return {
      buyer: bundle!.signatures.buyer ?? "",
      seller: bundle!.signatures.seller ?? "",
      allowance: depositSig,
      ...(readinessSig ? { readiness: readinessSig } : {}),
    };
  }

  async function depositRelayed() {
    if (!bundle || !draftId) return;
    await submitRelayFund(draftId, assembleRelayPayload(bundle, sigs()));
    setPendingNote("Submitted. Waiting for the deposit to land on Base (usually under a minute)…");
    const confirmed = await waitForFundingEvent(draftId, bundle.hub, bundle.dealId, { intervalMs: 5_000, timeoutMs: 300_000 });
    setPendingNote(null);
    setFundedTx(confirmed.txHash);
  }

  async function depositDirect() {
    if (!bundle) return;
    await ensureWallet();
    const account = (await getAccount()) as Address;
    const wallet = getWalletClient();
    await ensureChainId(wallet as unknown as { getChainId(): Promise<number> }, bundle.chainId);
    setPendingNote("Confirm in your wallet, then wait for inclusion…");
    const result = await directFund(bundle, sigs(), { account });
    setPendingNote(null);
    setFundedTx(result.fundTxHash);
  }

  const back = `/deals/${encodeURIComponent(id)}`;

  if (alreadyFunded || fundedTx) {
    return (
      <DealShell id={id} view={view} title="Escrow funded">
        <Card>
          <Callout tone="success" title="Your deposit is in escrow">
            The seller can now deliver. You&apos;ll inspect what you receive before any money is released.
          </Callout>
          {fundedTx ? (
            <p className="small" style={{ marginTop: 12 }}>
              <a href={`${EXPLORER}/tx/${fundedTx}`} target="_blank" rel="noreferrer">
                View the transaction
              </a>
            </p>
          ) : null}
          <ButtonLink href={back}>Back to the deal</ButtonLink>
        </Card>
      </DealShell>
    );
  }

  return (
    <DealShell
      id={id}
      view={view}
      title="Fund the escrow"
      subtitle={bundle ? `You'll deposit ${formatAmount(bundle.fundedUnits)} USDC. It stays in escrow until the deal completes.` : undefined}
    >
      {role !== "buyer" ? (
        <Callout tone="neutral">{role === "seller" ? "Only the buyer funds this deal." : "Sign in as the buyer to fund this deal."}</Callout>
      ) : !bundle ? (
        failure ? <Callout tone="danger">{failure}</Callout> : <div className="skeleton" style={{ height: 240 }} />
      ) : (
        <Card>
          <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
            <Step n={1} state={steps[0]!} title="Both sides signed the terms">
              <ButtonLink href={`${back}/review`} variant="secondary">
                Go to signing
              </ButtonLink>
            </Step>
            <Step n={2} state={steps[1]!} title="Funding approval from Midman">
              <p className="small muted">A quick automatic check against deal limits. It can&apos;t move funds.</p>
              <Button disabled={busy !== null} onClick={() => void run("approval", getApproval)}>
                {busy === "approval" ? "Checking…" : "Get funding approval"}
              </Button>
            </Step>
            <Step n={3} state={steps[2]!} title={`Have ${formatAmount(bundle.fundedUnits)} USDC ready`}>
              <p className="small muted">
                Wallet balance: {balance === null ? "unknown" : `${formatAmount(balance)} USDC`}
                {balance !== null && !enoughUsdc ? " — top up before continuing." : ""}
              </p>
              {enoughUsdc && !allowanceOk ? (
                <>
                  <p className="small muted">
                    Allow the escrow contract to take exactly {formatAmount(bundle.fundedUnits)} USDC. This is a one-off
                    wallet transaction and needs a little ETH on Base for gas.
                  </p>
                  <Button disabled={busy !== null} onClick={() => void run("approve", approveToken)}>
                    {busy === "approve" ? "Approving…" : "Allow USDC deposit"}
                  </Button>
                </>
              ) : (
                <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => void run("refresh", loadToken)}>
                  Check again
                </Button>
              )}
            </Step>
            <Step n={4} state={steps[3]!} title="Authorize the deposit">
              <p className="small muted">
                {readinessNeeded
                  ? "Two signatures: confirm you're ready to inspect within 3 hours, then authorize this exact deposit."
                  : "One signature authorizing this exact deposit for this deal only. No gas needed."}
              </p>
              <Button disabled={busy !== null} onClick={() => void run("authorize", authorize)}>
                {busy === "authorize" ? "Check your wallet…" : "Sign authorization"}
              </Button>
            </Step>
            <Step n={5} state={steps[4]!} title="Deposit into escrow">
              <div className="row">
                <Button size="lg" disabled={busy !== null} onClick={() => void run("relay", depositRelayed)}>
                  {busy === "relay" ? "Depositing…" : `Deposit ${formatAmount(bundle.fundedUnits)} USDC`}
                </Button>
                <Button variant="ghost" disabled={busy !== null} onClick={() => void run("direct", depositDirect)}>
                  Send it from my wallet instead
                </Button>
              </div>
              <p className="small muted" style={{ marginTop: 8, marginBottom: 0 }}>
                By default Midman submits the deposit for you and pays its gas.
              </p>
            </Step>
          </ol>
          {pendingNote ? (
            <div style={{ marginTop: 12 }}>
              <Callout tone="info">
                <span className="row" style={{ gap: 8 }}>
                  <Chip tone="info">Pending</Chip> {pendingNote}
                </span>
              </Callout>
            </div>
          ) : null}
          {failure ? (
            <div style={{ marginTop: 12 }}>
              <Callout tone="danger">{failure}</Callout>
            </div>
          ) : null}
        </Card>
      )}
    </DealShell>
  );
}
