"use client";

// Review & sign. The invited counterparty lands here from the private link:
// accept the invite, read the terms in plain language, confirm the dispute
// rules, and sign the full on-chain DealTerms (the one signature the escrow
// contract checks at funding). The creator signs here too.

import { use, useCallback, useEffect, useState } from "react";
import { postDealSignatures } from "../../../../lib/api";
import { getAccount } from "../../../../lib/wallet";
import { getWalletClient } from "../../../../lib/wallet";
import { fetchFundingBundle, signDealTerms, type FundingBundle } from "../../../../lib/funding";
import { acceptInvitationAsCounterparty, clearInviteFromLocation, readInviteToken } from "../../../../lib/invite";
import { formatAmount, formatSpan } from "../../../../lib/money";
import { friendlyError } from "../../../../lib/errors";
import { categoryLabel, shortAddress } from "../../../../lib/dealPhase";
import { useDeal } from "../../../components/useDeal";
import { useSession } from "../../../components/useSession";
import DealShell, { roleOf } from "../../../components/DealShell";
import { Button, ButtonLink, Callout, Card, Chip, Icon, KeyValues } from "../../../components/ui";

const RULES = [
  "The buyer can freeze the deal once, for free, during inspection. Both sides then have 24 hours to agree.",
  "If you don't agree, the buyer can escalate to an independent panel by posting a 5 USDC bond. The seller can post a matching bond to contest.",
  "If nobody escalates in time, the dispute lapses and the normal timeline resumes. The free freeze is used up.",
  "An escalated dispute can always exit after 60 days: the price splits 50/50 and fees are refunded.",
];

export default function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = use(params);
  const id = decodeURIComponent(rawId);
  const view = useDeal(id);
  const { session, connect, ensureWallet } = useSession();
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [bundle, setBundle] = useState<FundingBundle | null>(null);
  const [acked, setAcked] = useState(false);
  const [busy, setBusy] = useState<"accept" | "sign" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    // The invite token lives only in the URL fragment: never logged, sent
    // only to the accept endpoint.
    setInviteToken(readInviteToken(window.location.hash));
  }, []);

  const draftId = view.draftId ?? (id.startsWith("draft_") ? id : null);
  const role = roleOf(view, session?.wallet);

  const loadBundle = useCallback(async () => {
    if (!draftId || !view.terms || !role) return;
    try {
      setBundle(await fetchFundingBundle(draftId));
    } catch (e) {
      setFailure(friendlyError(e));
    }
  }, [draftId, view.terms, role]);

  useEffect(() => {
    void loadBundle();
  }, [loadBundle]);

  async function accept() {
    if (!inviteToken || !draftId) return;
    setBusy("accept");
    setFailure(null);
    try {
      await ensureWallet();
      const account = await getAccount();
      const wallet = getWalletClient();
      await acceptInvitationAsCounterparty({
        draftId,
        token: inviteToken,
        signer: { address: account, signMessage: (m: string) => wallet.signMessage({ account, message: m }) },
        chainId: Number(view.terms?.chainId ?? 8453),
      });
      // Drop the token from the visible URL only after the server accepted it.
      clearInviteFromLocation(window.location, window.history);
      window.location.reload();
    } catch (e) {
      setFailure(friendlyError(e));
    } finally {
      setBusy(null);
    }
  }

  async function sign() {
    if (!bundle || !role || !draftId) return;
    setBusy("sign");
    setFailure(null);
    try {
      await ensureWallet();
      const account = await getAccount();
      const expected = role === "buyer" ? view.terms!.buyer : view.terms!.seller;
      if (account.toLowerCase() !== expected.toLowerCase()) {
        throw new Error(`Switch your wallet to ${shortAddress(expected)}, the ${role} on this deal.`);
      }
      const signature = await signDealTerms(account, bundle.dealTermsTypedData);
      await postDealSignatures(draftId, { role, signature });
      await loadBundle();
    } catch (e) {
      setFailure(friendlyError(e));
    } finally {
      setBusy(null);
    }
  }

  const terms = view.terms;
  const needsAccept = Boolean(inviteToken) && (view.draftStatus === "invited" || view.draftStatus === "draft" || !terms);

  // Not a party yet (fresh invitee): accept first, terms load afterwards.
  if (!terms) {
    return (
      <DealShell id={id} view={view} title="You've been invited to a deal" allowWithoutTerms>
        <Card>
          {inviteToken ? (
            <div className="stack">
              <p style={{ margin: 0 }}>
                Someone invited you to a USDC escrow deal. Sign in with the wallet address they invited to see the
                terms. Nothing is charged by accepting.
              </p>
              {failure ? <Callout tone="danger">{failure}</Callout> : null}
              <Button size="lg" disabled={busy !== null} onClick={() => void accept()}>
                {busy === "accept" ? "Check your wallet…" : "Sign in & view the deal"}
              </Button>
            </div>
          ) : (
            <div className="stack">
              <p style={{ margin: 0 }}>Sign in with the wallet named in this deal to review it.</p>
              <Button onClick={() => void connect().then(() => window.location.reload()).catch(() => undefined)}>
                Sign in with wallet
              </Button>
            </div>
          )}
        </Card>
      </DealShell>
    );
  }

  const mySig = role && bundle ? bundle.signatures[role] : null;
  const otherRole = role === "buyer" ? "seller" : "buyer";
  const otherSig = role && bundle ? bundle.signatures[otherRole] : null;
  const bothSigned = Boolean(bundle?.signatures.buyer && bundle?.signatures.seller);
  const pays = role === "buyer" ? terms.fundedUnits : null;
  const receives = view.quote?.sellerClaim ?? null;

  return (
    <DealShell
      id={id}
      view={view}
      title={bothSigned ? "Terms signed" : "Review & sign"}
      subtitle={
        bothSigned
          ? "Both sides signed the same terms."
          : "Check the terms below. Signing commits you to them once the buyer funds the escrow."
      }
    >
      {needsAccept && role ? (
        <Card title="Accept the invitation">
          <p className="small muted">Confirms you are the invited {role}. It doesn&apos;t move any funds.</p>
          <Button disabled={busy !== null} onClick={() => void accept()}>
            {busy === "accept" ? "Check your wallet…" : "Accept invitation"}
          </Button>
        </Card>
      ) : null}

      <Card title={terms["title"] || categoryLabel(terms.category)}>
        {terms["agreementText"] ? (
          <p style={{ whiteSpace: "pre-wrap" }}>{terms["agreementText"]}</p>
        ) : (
          <p className="small muted">No written description was attached. Agree on the details before signing.</p>
        )}
        <hr className="divider" />
        <KeyValues
          rows={[
            { label: "Price", value: `${formatAmount(terms.principalUnits)} USDC` },
            { label: "Platform fee", value: `${formatAmount(terms.quotedFeeUnits)} USDC` },
            { label: "Buyer deposits", value: `${formatAmount(terms.fundedUnits)} USDC` },
            ...(receives ? [{ label: "Seller receives on release", value: `${formatAmount(receives)} USDC` }] : []),
            { label: "Delivery window", value: formatSpan(Number(terms.deliverySeconds)) },
            { label: "Inspection window", value: formatSpan(Number(terms.inspectionSeconds)) },
            { label: "Category", value: categoryLabel(terms.category) },
            { label: "Buyer", value: <span className="mono">{shortAddress(terms.buyer)}</span> },
            { label: "Seller", value: <span className="mono">{shortAddress(terms.seller)}</span> },
          ]}
        />
        {role === "buyer" && pays ? (
          <Callout tone="info">You will deposit {formatAmount(pays)} USDC when you fund.</Callout>
        ) : null}
      </Card>

      <Card title="If something goes wrong">
        <ul style={{ margin: "0 0 12px", paddingLeft: 18 }} className="small">
          {RULES.map((rule) => (
            <li key={rule} style={{ marginBottom: 6 }}>
              {rule}
            </li>
          ))}
        </ul>
        <label className="row small" style={{ gap: 8, alignItems: "flex-start" }}>
          <input type="checkbox" checked={acked} onChange={(e) => setAcked(e.target.checked)} style={{ width: "auto", marginTop: 3 }} />
          <span>I understand how disputes work on this deal.</span>
        </label>
      </Card>

      <Card title="Signatures">
        <div className="stack" style={{ gap: 10 }}>
          {(["buyer", "seller"] as const).map((r) => (
            <div key={r} className="row spread">
              <span>
                {r === "buyer" ? "Buyer" : "Seller"} {role === r ? <Chip tone="info">You</Chip> : null}
              </span>
              {bundle?.signatures[r] ? <Chip tone="success">Signed</Chip> : <Chip>Waiting</Chip>}
            </div>
          ))}
        </div>
        <hr className="divider" />
        {failure ? <Callout tone="danger">{failure}</Callout> : null}
        {!session ? (
          <Button onClick={() => void connect().then(() => window.location.reload()).catch(() => undefined)}>Sign in to sign</Button>
        ) : !role ? (
          <Callout tone="neutral">Your wallet isn&apos;t the buyer or seller on this deal.</Callout>
        ) : bothSigned ? (
          role === "buyer" ? (
            <ButtonLink href={`/deals/${encodeURIComponent(id)}/fund`} size="lg">
              Continue to funding <Icon name="arrow-right" size={16} />
            </ButtonLink>
          ) : (
            <Callout tone="success">You&apos;re all set. The buyer funds the escrow next; we&apos;ll show it on the deal page.</Callout>
          )
        ) : mySig ? (
          <Callout tone="info">You signed. Waiting for the {otherRole} to sign{otherSig ? "" : " — share the invite link if they haven't opened it"}.</Callout>
        ) : (
          <Button size="lg" block disabled={!acked || !bundle || busy !== null || needsAccept} onClick={() => void sign()}>
            {busy === "sign" ? "Check your wallet…" : `Sign the terms as ${role}`}
          </Button>
        )}
        {!acked && !mySig && role ? (
          <p className="small muted" style={{ marginTop: 8, marginBottom: 0 }}>
            Tick the box above to enable signing.
          </p>
        ) : null}
      </Card>
    </DealShell>
  );
}
