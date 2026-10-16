"use client";

// Create a deal in three steps: what and how much, timeline and fees, who
// with. Chain binding (hub, token, policies, fee recipients) comes from the
// verified deployment configuration and is pinned again by the API, so the
// user never types contract addresses.

import { useEffect, useMemo, useState } from "react";
import { keccak256, stringToHex, type Address } from "viem";
import { quoteFee } from "@midman/shared";
import { createDraft, inviteDraft, ApiError } from "../../../lib/api";
import { formatAmount, formatSpan, parseUSDC } from "../../../lib/money";
import { CATEGORY_MINIMUMS, isHexAddress } from "../../../lib/deal";
import { categoryLabel } from "../../../lib/dealPhase";
import { agreementBindingFromDefaults, fetchDealDefaults, type DealDefaults } from "../../../lib/dealDefaults";
import { useSession } from "../../components/useSession";
import { Button, ButtonLink, Callout, Card, Field, Icon, KeyValues, Segmented } from "../../components/ui";

const HOUR = 3_600;
const DAY = 86_400;

const CATEGORY_HELP: Record<string, string> = {
  INSTANT_CODE: "Gift cards, keys and codes you can check right away.",
  GAME_ITEM: "Skins, items and in-game goods.",
  GAME_CURRENCY: "Gold, coins and other in-game currency.",
  DIGITAL_GOOD: "Files, licences, designs and other digital products.",
  SERVICE: "Work done for you: boosting, design, development.",
  GAME_ACCOUNT: "Whole accounts. We recommend 72 hours to inspect.",
};

const DELIVERY_PRESETS = [
  { value: HOUR, label: "1 hour" },
  { value: 6 * HOUR, label: "6 hours" },
  { value: DAY, label: "1 day" },
  { value: 3 * DAY, label: "3 days" },
  { value: 7 * DAY, label: "7 days" },
];

const INSPECTION_PRESETS = [HOUR, 12 * HOUR, DAY, 3 * DAY, 7 * DAY, 14 * DAY];

const FEE_PAYERS = [
  { value: 10_000, label: "Buyer pays" },
  { value: 5_000, label: "Split 50/50" },
  { value: 0, label: "Seller pays" },
] as const;

type FeeBps = 0 | 5_000 | 10_000;
type Role = "buyer" | "seller";

function feeTierNote(durationSeconds: number): string {
  if (durationSeconds <= 3 * HOUR) return "0.25% tier (3 hours or less)";
  if (durationSeconds < DAY) return "0.50% tier (under 24 hours)";
  if (durationSeconds <= 3 * DAY) return "0.70% tier (1 to 3 days)";
  if (durationSeconds <= 7 * DAY) return "1.00% tier (3 to 7 days)";
  return "2.00% tier (over 7 days)";
}

function WizardSteps({ step }: { step: number }) {
  const labels = ["The deal", "Timeline & fees", "Counterparty"];
  return (
    <ol className="wizard-steps" aria-label="Steps">
      {labels.map((label, i) => (
        <li key={label} data-state={i < step ? "done" : i === step ? "current" : "todo"}>
          <span className="num-badge">{i < step ? <Icon name="check" size={13} /> : i + 1}</span>
          {label}
        </li>
      ))}
    </ol>
  );
}

export default function NewDealPage() {
  const { session, connect } = useSession();
  const [step, setStep] = useState(0);
  const [role, setRole] = useState<Role>("buyer");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("GAME_ITEM");
  const [amount, setAmount] = useState("");
  const [delivery, setDelivery] = useState<number>(DAY);
  const [inspection, setInspection] = useState<number>(DAY);
  const [feeBps, setFeeBps] = useState<FeeBps>(10_000);
  const [counterparty, setCounterparty] = useState("");
  const [defaults, setDefaults] = useState<DealDefaults | null>(null);
  const [defaultsError, setDefaultsError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<{ draftId: string; inviteUrl: string } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetchDealDefaults()
      .then(setDefaults)
      .catch((e: unknown) => setDefaultsError(e instanceof Error ? e.message : String(e)));
  }, []);

  const minInspection = CATEGORY_MINIMUMS[category] ?? HOUR;
  // Keep inspection valid when the category changes.
  useEffect(() => {
    if (inspection < minInspection) setInspection(category === "GAME_ACCOUNT" ? 3 * DAY : minInspection);
  }, [category, inspection, minInspection]);

  const amountUnits = useMemo(() => {
    try {
      return BigInt(parseUSDC(amount));
    } catch {
      return null;
    }
  }, [amount]);
  const amountError =
    amount.trim() === "" ? null : amountUnits === null ? "Enter an amount like 250 or 99.50" : amountUnits < 5_000_000n ? "The minimum deal is 5.00 USDC" : null;

  const quote = useMemo(() => {
    if (amountUnits === null || amountUnits < 5_000_000n) return null;
    const fee = quoteFee(amountUnits, delivery + inspection);
    const buyerFee = (fee * BigInt(feeBps)) / 10_000n;
    const sellerFee = fee - buyerFee;
    return { fee, buyerDeposits: amountUnits + buyerFee, sellerReceives: amountUnits - sellerFee };
  }, [amountUnits, delivery, inspection, feeBps]);

  const counterpartyError =
    counterparty.trim() === ""
      ? null
      : !isHexAddress(counterparty.trim())
        ? "Enter a wallet address (0x followed by 40 characters)"
        : session && counterparty.trim().toLowerCase() === session.wallet.toLowerCase()
          ? "That's your own wallet"
          : null;

  const step0Valid = title.trim().length > 0 && amountError === null && quote !== null;
  const step2Valid = isHexAddress(counterparty.trim()) && counterpartyError === null && defaults !== null;

  async function submit() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      if (!defaults) throw new Error(defaultsError ?? "Deal configuration is still loading");
      if (!quote || amountUnits === null) throw new Error("Check the amount");
      const active = session ?? (await connect());
      const me = active.wallet as Address;
      const other = counterparty.trim() as Address;
      const agreementText = [title.trim(), description.trim()].filter(Boolean).join("\n\n");
      const binding = agreementBindingFromDefaults(defaults);
      const created = await createDraft({
        creatorWallet: me,
        // Only this wallet can accept the invite.
        counterpartyHint: other,
        title: title.trim(),
        agreementText,
        terms: {
          buyer: role === "buyer" ? me : other,
          seller: role === "seller" ? me : other,
          principalUnits: amountUnits.toString(),
          buyerFeeBps: feeBps,
          deliverySeconds: delivery,
          inspectionSeconds: inspection,
          category,
          agreementHash: keccak256(stringToHex(agreementText)),
          policyIds: binding.policyIds,
          platformFeeRecipient: binding.platformFeeRecipient,
          arbitrationCostRecipient: binding.arbitrationCostRecipient,
          hub: binding.hub,
          token: binding.token,
          chainId: binding.chainId,
          fundingDays: 7,
        },
      });
      const invite = await inviteDraft(created.id);
      setResult({
        draftId: created.id,
        inviteUrl: `${window.location.origin}/deals/${created.id}/review#invite=${invite.invitationToken}`,
      });
    } catch (e) {
      setSubmitError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  if (result) {
    return (
      <main className="container container-narrow page stack">
        <div>
          <span className="feature-icon" style={{ background: "var(--success-soft)", color: "var(--success)" }}>
            <Icon name="check" />
          </span>
          <h1>Your deal is drafted</h1>
          <p className="muted">Send this private link to the other side. Only their wallet can accept it.</p>
        </div>
        <Card>
          <div className="row">
            <input readOnly value={result.inviteUrl} aria-label="Invite link" className="mono" style={{ flex: "1 1 280px", width: "auto" }} />
            <Button
              onClick={() => {
                void navigator.clipboard.writeText(result.inviteUrl).then(() => setCopied(true));
              }}
            >
              {copied ? "Copied" : "Copy link"}
            </Button>
          </div>
          <p className="small muted" style={{ marginTop: 10 }}>
            The invite code sits after the # in the link, so it never reaches any server log. It expires in 7 days.
          </p>
        </Card>
        <Card title="What happens next">
          <ol className="timeline">
            <li>
              <span className="num-badge">1</span>
              <div>They open the link, sign in with their wallet and accept.</div>
            </li>
            <li>
              <span className="num-badge">2</span>
              <div>You both sign the same terms.</div>
            </li>
            <li>
              <span className="num-badge">3</span>
              <div>The buyer funds the escrow and the seller can deliver.</div>
            </li>
          </ol>
        </Card>
        <div className="row">
          <ButtonLink href={`/deals/${encodeURIComponent(result.draftId)}`}>Open the deal</ButtonLink>
          <ButtonLink href="/deals" variant="secondary">
            My deals
          </ButtonLink>
        </div>
      </main>
    );
  }

  return (
    <main className="container page">
      <div className="grid-2" style={{ alignItems: "start", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 380px), 1fr))" }}>
        <div className="stack">
          <div>
            <h1>New deal</h1>
            <p className="muted">Draft the terms. Nothing is charged until the buyer funds the escrow.</p>
          </div>
          <WizardSteps step={step} />
          {defaultsError ? (
            <Callout tone="danger" title="Deals can't be created right now">
              The deployment configuration could not be loaded ({defaultsError}).
            </Callout>
          ) : null}

          {step === 0 ? (
            <Card>
              <div className="stack">
                <Field label="I am">
                  <Segmented
                    label="Your role"
                    value={role}
                    options={[
                      { value: "buyer", label: "Buying (I pay)" },
                      { value: "seller", label: "Selling (I deliver)" },
                    ]}
                    onChange={setRole}
                  />
                </Field>
                <Field label="What is being sold?" htmlFor="title" hint="A short title both sides will see.">
                  <input id="title" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Rare skin bundle" />
                </Field>
                <Field label="Details (optional)" htmlFor="details" hint="Exactly what will be delivered and how. This becomes part of the signed agreement.">
                  <textarea id="details" maxLength={3_800} value={description} onChange={(e) => setDescription(e.target.value)} />
                </Field>
                <Field label="Category" htmlFor="category" hint={`${CATEGORY_HELP[category] ?? ""} Minimum inspection: ${formatSpan(minInspection)}.`}>
                  <select id="category" value={category} onChange={(e) => setCategory(e.target.value)}>
                    {Object.keys(CATEGORY_MINIMUMS).map((key) => (
                      <option key={key} value={key}>
                        {categoryLabel(key)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Price (USDC)" htmlFor="amount" error={amountError} hint="Minimum 5.00 USDC.">
                  <input id="amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="250.00" />
                </Field>
                <Button size="lg" disabled={!step0Valid} onClick={() => setStep(1)}>
                  Continue
                </Button>
              </div>
            </Card>
          ) : null}

          {step === 1 ? (
            <Card>
              <div className="stack">
                <Field label="Delivery window" hint="How long the seller has to deliver after funding. If they don't, the buyer gets a full refund.">
                  <Segmented label="Delivery window" value={delivery} options={DELIVERY_PRESETS} onChange={setDelivery} />
                </Field>
                <Field label="Inspection window" hint="How long the buyer has to check the delivery. Payment releases automatically when it ends.">
                  <Segmented
                    label="Inspection window"
                    value={inspection}
                    options={INSPECTION_PRESETS.filter((s) => s >= minInspection).map((s) => ({ value: s, label: formatSpan(s) }))}
                    onChange={setInspection}
                  />
                </Field>
                <Field label="Who pays the fee?">
                  <Segmented label="Fee payer" value={feeBps} options={FEE_PAYERS} onChange={(v) => setFeeBps(v as FeeBps)} />
                </Field>
                <div className="row">
                  <Button variant="secondary" onClick={() => setStep(0)}>
                    Back
                  </Button>
                  <Button size="lg" onClick={() => setStep(2)} style={{ flex: 1 }}>
                    Continue
                  </Button>
                </div>
              </div>
            </Card>
          ) : null}

          {step === 2 ? (
            <Card>
              <div className="stack">
                <Field
                  label={role === "buyer" ? "Seller's wallet address" : "Buyer's wallet address"}
                  htmlFor="counterparty"
                  error={counterpartyError}
                  hint="Only this wallet will be able to accept your invite. Ask them to copy it from their wallet."
                >
                  <input
                    id="counterparty"
                    className="mono"
                    value={counterparty}
                    onChange={(e) => setCounterparty(e.target.value)}
                    placeholder="0x…"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>
                {!session ? (
                  <Callout tone="info">
                    You&apos;ll be asked to sign in with your wallet. Signing in authorizes no funds.
                  </Callout>
                ) : null}
                {submitError ? <Callout tone="danger" title="The deal wasn't created">{submitError}</Callout> : null}
                <div className="row">
                  <Button variant="secondary" onClick={() => setStep(1)}>
                    Back
                  </Button>
                  <Button size="lg" disabled={!step2Valid || submitting} onClick={() => void submit()} style={{ flex: 1 }}>
                    {submitting ? "Creating…" : session ? "Create deal & get invite link" : "Sign in & create deal"}
                  </Button>
                </div>
              </div>
            </Card>
          ) : null}
        </div>

        <aside className="card" style={{ position: "sticky", top: 84 }} aria-label="Deal summary">
          <span className="eyebrow">Summary</span>
          <h2 style={{ margin: "8px 0 2px" }}>{title.trim() || "Untitled deal"}</h2>
          <p className="small muted">
            {categoryLabel(category)} · you are the {role}
          </p>
          <div className="amount amount-lg" style={{ margin: "14px 0" }}>
            {amountUnits !== null ? formatAmount(amountUnits) : "0.00"} <span className="muted" style={{ fontSize: "1rem" }}>USDC</span>
          </div>
          {quote ? (
            <KeyValues
              rows={[
                { label: "Platform fee", value: `${formatAmount(quote.fee)} USDC` },
                { label: "Buyer deposits", value: `${formatAmount(quote.buyerDeposits)} USDC` },
                { label: "Seller receives on release", value: `${formatAmount(quote.sellerReceives)} USDC`, total: true },
              ]}
            />
          ) : (
            <p className="small muted">Enter a price to see fees.</p>
          )}
          <hr className="divider" />
          <KeyValues
            rows={[
              { label: "Delivery window", value: formatSpan(delivery) },
              { label: "Inspection window", value: formatSpan(inspection) },
              { label: "Fee rate", value: feeTierNote(delivery + inspection) },
            ]}
          />
          <p className="small muted" style={{ marginTop: 12, marginBottom: 0 }}>
            The buyer has 7 days to fund once both sides sign. Shorter deals are cheaper: the fee depends on delivery plus
            inspection time.
          </p>
        </aside>
      </div>
    </main>
  );
}
