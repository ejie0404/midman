"use client";

// Payouts. Each payout goes to the address fixed in the signed terms, so
// anyone may trigger it (Midman's relayer usually does). Also offers the
// permissionless deadline actions: refund when delivery is overdue, release
// when inspection has ended.

import { use, useCallback, useEffect, useState } from "react";
import { encodeFunctionData, type Address, type Hash } from "viem";
import { HUB_ABI } from "@midman/chain";
import { getRecovery, relaySubmit, type RecoveryPackage } from "../../../../lib/api";
import { getPublicClient, sendDirect, waitForInclusion } from "../../../../lib/wallet";
import { CLAIM_KINDS } from "../../../../lib/deal";
import { formatAmount } from "../../../../lib/money";
import { friendlyError } from "../../../../lib/errors";
import { shortAddress } from "../../../../lib/dealPhase";
import { useDeal } from "../../../components/useDeal";
import { useSession } from "../../../components/useSession";
import DealShell, { chainPhaseOf } from "../../../components/DealShell";
import { Button, Callout, Card, Chip } from "../../../components/ui";

const PAYOUT_NAMES: Record<number, string> = {
  0: "Buyer refund",
  1: "Seller payment",
  2: "Platform fee",
  3: "Buyer bond refund",
  4: "Seller bond refund",
  5: "Arbitration cost",
};

interface Payout {
  readonly kind: number;
  readonly recipient: Address;
  readonly amount: bigint;
}

export default function ClaimPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = use(params);
  const id = decodeURIComponent(rawId);
  const view = useDeal(id);
  const { session, ensureWallet } = useSession();
  const [payouts, setPayouts] = useState<Payout[] | null>(null);
  const [recovery, setRecovery] = useState<RecoveryPackage | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const terms = view.terms;
  const phase = chainPhaseOf(view);
  const hub = (terms?.hub ?? "") as Address;
  const dealId = view.dealId as Hash | null;
  const now = Math.floor(Date.now() / 1_000);
  const deliveryOverdue =
    phase === "AWAITING_DELIVERY" && view.dealStatus?.fundedAt && terms
      ? now >= Number(view.dealStatus.fundedAt) + Number(terms.deliverySeconds)
      : false;
  const inspectionOver =
    phase === "DELIVERED" && view.dealStatus?.deliveredAt && terms
      ? now >= Number(view.dealStatus.deliveredAt) + Number(terms.inspectionSeconds)
      : false;

  const loadPayouts = useCallback(async () => {
    if (!dealId || !hub) return;
    try {
      const client = getPublicClient();
      const rows = await Promise.all(
        CLAIM_KINDS.map(async ({ kind }) => {
          const claimId = (await client.readContract({ address: hub, abi: HUB_ABI, functionName: "claimIdOf", args: [dealId, kind] } as never)) as Hash;
          const [recipient, amount] = (await client.readContract({ address: hub, abi: HUB_ABI, functionName: "getClaim", args: [claimId] } as never)) as [Address, bigint];
          return { kind, recipient, amount };
        }),
      );
      setPayouts(rows.filter((row) => row.amount > 0n));
    } catch (e) {
      setFailure(friendlyError(e));
    }
  }, [dealId, hub]);

  useEffect(() => {
    if (phase === "SETTLED") void loadPayouts();
  }, [phase, loadPayouts]);

  async function run(label: string, action: () => Promise<void>) {
    setBusy(label);
    setFailure(null);
    setNotice(null);
    try {
      await action();
    } catch (e) {
      setFailure(friendlyError(e));
    } finally {
      setBusy(null);
    }
  }

  async function relayed(action: string, params: Record<string, unknown>, message: string) {
    await relaySubmit(`${action}-${dealId!.slice(2, 14)}-${Date.now()}`, action, { dealId, ...params });
    setNotice(message);
  }

  async function claimDirect(kind: number) {
    await ensureWallet();
    const data = encodeFunctionData({ abi: HUB_ABI, functionName: "claimFor", args: [dealId!, kind] } as never) as Hash;
    const hash = await sendDirect(hub, data);
    await waitForInclusion(hash);
    await loadPayouts();
    setNotice("Paid out.");
  }

  const me = session?.wallet.toLowerCase();

  return (
    <DealShell id={id} view={view} title="Payouts">
      {deliveryOverdue ? (
        <Card title="Delivery is overdue">
          <p className="small muted">The seller didn&apos;t mark delivery in time. The buyer can take a full refund, including the prepaid fee.</p>
          <Button
            disabled={busy !== null}
            onClick={() => void run("refund", () => relayed("refundForNonDelivery", {}, "Refund submitted. Payouts appear here once it lands."))}
          >
            {busy === "refund" ? "Submitting…" : "Refund the buyer now"}
          </Button>
        </Card>
      ) : null}

      {inspectionOver ? (
        <Card title="Inspection has ended">
          <p className="small muted">No dispute was opened, so payment can be released to the seller.</p>
          <Button
            disabled={busy !== null}
            onClick={() => void run("finalize", () => relayed("finalizeAfterTimeout", {}, "Release submitted. Payouts appear here once it lands."))}
          >
            {busy === "finalize" ? "Submitting…" : "Release payment now"}
          </Button>
        </Card>
      ) : null}

      {phase !== "SETTLED" ? (
        !deliveryOverdue && !inspectionOver ? (
          <Callout tone="info">Payouts become available once the deal is settled.</Callout>
        ) : null
      ) : (
        <Card title="Payouts for this deal">
          {payouts === null ? (
            <div className="skeleton" style={{ height: 120 }} />
          ) : payouts.length === 0 ? (
            <Callout tone="success">Everything has been paid out.</Callout>
          ) : (
            <div className="stack" style={{ gap: 12 }}>
              {payouts.map((p) => (
                <div key={p.kind} className="row spread" style={{ borderBottom: "1px solid var(--border)", paddingBottom: 12 }}>
                  <div>
                    <div className="row" style={{ gap: 8 }}>
                      <strong>{PAYOUT_NAMES[p.kind] ?? `Payout ${p.kind}`}</strong>
                      {me && p.recipient.toLowerCase() === me ? <Chip tone="info">Yours</Chip> : null}
                    </div>
                    <div className="small muted">
                      to <span className="mono">{shortAddress(p.recipient)}</span>
                    </div>
                  </div>
                  <div className="row" style={{ gap: 10 }}>
                    <span className="amount">{formatAmount(p.amount)} USDC</span>
                    <Button
                      size="sm"
                      disabled={busy !== null}
                      onClick={() =>
                        void run(`claim-${p.kind}`, () =>
                          relayed("claimFor", { kind: p.kind }, "Payout submitted. It arrives in the recipient wallet shortly."),
                        )
                      }
                    >
                      {busy === `claim-${p.kind}` ? "Submitting…" : "Pay out"}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void run(`direct-${p.kind}`, () => claimDirect(p.kind))}>
                      From my wallet
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <p className="small muted" style={{ marginTop: 12, marginBottom: 0 }}>
            Payouts always go to the addresses fixed in the signed terms. Nobody, including Midman, can redirect them.
          </p>
        </Card>
      )}

      {notice ? <Callout tone="success">{notice}</Callout> : null}
      {failure ? <Callout tone="danger">{failure}</Callout> : null}

      {dealId ? (
        <details className="card">
          <summary style={{ cursor: "pointer", fontWeight: 560 }}>Emergency recovery (if Midman is offline)</summary>
          <p className="small muted" style={{ marginTop: 10 }}>
            Every payout can be triggered directly on the contract without Midman. Download this package and keep it.
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              void run("recovery", async () => {
                setRecovery(await getRecovery(dealId));
              })
            }
          >
            Load recovery package
          </Button>
          {recovery ? (
            <div className="stack small" style={{ gap: 8, marginTop: 12 }}>
              <div className="mono" style={{ wordBreak: "break-all" }}>
                contract {recovery.hub} · chain {recovery.chainId}
              </div>
              {Object.entries(recovery.emergencyCalldata).map(([name, data]) => (
                <div key={name}>
                  <div style={{ fontWeight: 600 }}>{name}</div>
                  <div className="mono" style={{ wordBreak: "break-all" }}>
                    {data}
                  </div>
                </div>
              ))}
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  const blob = new Blob([JSON.stringify(recovery, null, 2)], { type: "application/json" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `midman-recovery-${dealId}.json`;
                  a.click();
                  URL.revokeObjectURL(url);
                }}
              >
                Download JSON
              </Button>
            </div>
          ) : null}
        </details>
      ) : null}
    </DealShell>
  );
}
