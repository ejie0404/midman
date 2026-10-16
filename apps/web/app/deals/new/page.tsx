"use client";

import { useMemo, useState, useEffect } from "react";
import { keccak256, stringToHex, type Address } from "viem";
import { quoteFee } from "@midman/shared";
import { createDraft, inviteDraft, ApiError } from "../../../lib/api";
import { formatUSDC, parseUSDC } from "../../../lib/money";
import { CHAIN_ID, HUB_ADDRESS, USDC_ADDRESS, getAccount } from "../../../lib/wallet";
import {
  CATEGORIES,
  CATEGORY_MINIMUMS,
  FEE_ALLOCATIONS,
  isHexAddress,
} from "../../../lib/deal";
import {
  agreementBindingFromDefaults,
  describeAgreement,
  fetchDealDefaults,
  type DealDefaults,
} from "../../../lib/dealDefaults";
import { button, card, error, input, label, mono, ok, page, secondaryButton, warning } from "../../components/styles";
import { useSession } from "../../components/useSession";

function toSeconds(hours: string): number | null {
  if (!/^\d+(\.\d+)?$/.test(hours.trim())) return null;
  const seconds = Math.round(Number(hours) * 3_600);
  return Number.isInteger(seconds) ? seconds : null;
}

export default function NewDealPage() {
  const [role, setRole] = useState<"buyer" | "seller">("buyer");
  const [creatorWallet, setCreatorWallet] = useState("");
  const { session, connect } = useSession();
  const [counterparty, setCounterparty] = useState("");
  const [counterpartyHint, setCounterpartyHint] = useState("");
  const [principal, setPrincipal] = useState("100");
  const [deliveryHours, setDeliveryHours] = useState("24");
  const [inspectionHours, setInspectionHours] = useState("24");
  const [category, setCategory] = useState<string>(CATEGORIES[3] ?? "DIGITAL_GOOD");
  const [feeBps, setFeeBps] = useState<0 | 5_000 | 10_000>(10_000);
  const [description, setDescription] = useState("");
  const [hub, setHub] = useState<string>(HUB_ADDRESS);
  const [token, setToken] = useState<string>(USDC_ADDRESS);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [defaults, setDefaults] = useState<DealDefaults | null>(null);
  const [defaultsError, setDefaultsError] = useState<string | null>(null);
  const [result, setResult] = useState<{ draftId: string; dealId: string; inviteUrl: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const loaded = await fetchDealDefaults();
        if (!cancelled) setDefaults(loaded);
      } catch (e) {
        if (!cancelled) {
          setDefaultsError(
            e instanceof Error
              ? `Verified deal configuration unavailable (${e.message}). Refusing to build a draft with empty policy ids.`
              : "Verified deal configuration unavailable.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const preview = useMemo(() => {
    try {
      const principalUnits = BigInt(parseUSDC(principal));
      const deliverySeconds = toSeconds(deliveryHours);
      const inspectionSeconds = toSeconds(inspectionHours);
      if (deliverySeconds === null || inspectionSeconds === null) {
        return { error: "Durations must be decimal hours." };
      }
      const minInspection = CATEGORY_MINIMUMS[category] ?? 0;
      if (deliverySeconds < 3_600 || deliverySeconds > 2_592_000) {
        return { error: "Delivery must be 1h–30d." };
      }
      if (inspectionSeconds < minInspection || inspectionSeconds > 1_209_600) {
        return { error: `Inspection violates the ${category} minimum.` };
      }
      const duration = deliverySeconds + inspectionSeconds;
      const quoted = quoteFee(principalUnits, duration);
      const prepaid = (quoted * BigInt(feeBps)) / 10_000n;
      return {
        principalUnits: principalUnits.toString(),
        quoted: quoted.toString(),
        prepaid: prepaid.toString(),
        funded: (principalUnits + prepaid).toString(),
        duration,
      };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [principal, deliveryHours, inspectionHours, category, feeBps]);

  async function useConnectedWallet() {
    try {
      setCreatorWallet(await getAccount());
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    }
  }

  async function submit() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      // Drafts are created by a signed-in wallet (the API binds the creator to
      // the session). Sign in first when needed; the session wallet is the
      // creator, whatever was typed in the field.
      const active =
        session && creatorWallet !== "" && session.wallet.toLowerCase() === creatorWallet.toLowerCase()
          ? session
          : await connect();
      const signedInWallet = active.wallet;
      setCreatorWallet(signedInWallet);
      if (!isHexAddress(signedInWallet)) throw new Error("Creator wallet must be a 0x address");
      if (!isHexAddress(counterparty)) throw new Error("Counterparty must be a 0x address");
      if (!defaults) throw new Error(defaultsError ?? "Verified deal configuration is not loaded yet");
      if (!preview || "error" in preview || !preview.principalUnits) throw new Error(preview?.error ?? "Invalid preview");
      const deliverySeconds = toSeconds(deliveryHours);
      const inspectionSeconds = toSeconds(inspectionHours);
      if (deliverySeconds === null || inspectionSeconds === null) throw new Error("Invalid durations");
      const buyer = (role === "buyer" ? signedInWallet : counterparty) as Address;
      const seller = (role === "buyer" ? counterparty : signedInWallet) as Address;
      const agreementHash = keccak256(stringToHex(description.trim() === "" ? `midman:${Date.now()}` : description));
      // Agreement binding comes ONLY from verified configuration: real hub,
      // USDC, chain id, the eight policy ids, and the configured recipients.
      const binding = agreementBindingFromDefaults(defaults);
      const terms = {
        buyer,
        seller,
        principalUnits: preview.principalUnits,
        buyerFeeBps: feeBps,
        deliverySeconds,
        inspectionSeconds,
        category,
        agreementHash,
        policyIds: binding.policyIds,
        platformFeeRecipient: binding.platformFeeRecipient,
        arbitrationCostRecipient: binding.arbitrationCostRecipient,
        hub: binding.hub,
        token: binding.token,
        chainId: binding.chainId,
        fundingDays: 7,
      };
      const body: { creatorWallet: string; terms: Record<string, unknown>; counterpartyHint?: string } = {
        creatorWallet: signedInWallet,
        terms: terms as unknown as Record<string, unknown>,
      };
      if (counterpartyHint.trim() !== "") body.counterpartyHint = counterpartyHint.trim();
      const created = await createDraft(body);
      const invite = await inviteDraft(created.id);
      const origin = window.location.origin;
      setResult({
        draftId: created.id,
        dealId: created.dealId,
        inviteUrl: `${origin}/deals/${created.id}/review#invite=${invite.invitationToken}`,
      });
    } catch (e) {
      setSubmitError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  if (result) {
    return (
      <main style={page}>
        <h1>Draft created — share the invite link</h1>
        <div style={ok}>
          <p>
            Draft <span style={mono}>{result.draftId}</span> · deal <span style={mono}>{result.dealId}</span>
          </p>
          <p>
            Send this private link to the counterparty. The invitation token lives only in the URL fragment (after
            #) — it is never logged and never sent to the server.
          </p>
          <p style={mono}>{result.inviteUrl}</p>
          <button
            type="button"
            style={secondaryButton}
            onClick={() => {
              void navigator.clipboard.writeText(result.inviteUrl);
            }}
          >
            Copy invite link
          </button>
        </div>
        <p>
          <a href={`/deals/${result.draftId}`}>Open deal dashboard</a> ·{" "}
          <a href={`/deals/${result.draftId}/review`}>Open review & sign</a>
        </p>
      </main>
    );
  }

  return (
    <main style={page}>
      <h1>New deal</h1>
      <p>
        <a href="/">← Home</a>
      </p>

      <label style={label}>Your role</label>
      <select value={role} onChange={(e) => setRole(e.target.value as "buyer" | "seller")} style={input}>
        <option value="buyer">I am the buyer (I fund)</option>
        <option value="seller">I am the seller (I deliver)</option>
      </select>

      <label style={label}>Your wallet address</label>
      <input style={input} value={creatorWallet} onChange={(e) => setCreatorWallet(e.target.value)} placeholder="0x…" />
      <button type="button" style={secondaryButton} onClick={() => void useConnectedWallet()}>
        Use connected wallet
      </button>

      <label style={label}>Counterparty address</label>
      <input style={input} value={counterparty} onChange={(e) => setCounterparty(e.target.value)} placeholder="0x…" />

      <label style={label}>Counterparty hint (optional, must match on accept)</label>
      <input
        style={input}
        value={counterpartyHint}
        onChange={(e) => setCounterpartyHint(e.target.value)}
        placeholder="email, handle, or address"
      />

      <label style={label}>Principal (USDC, decimal — converted to exact units, no floats)</label>
      <input style={input} value={principal} onChange={(e) => setPrincipal(e.target.value)} inputMode="decimal" />

      <label style={label}>Delivery (hours, 1h–720h)</label>
      <input style={input} value={deliveryHours} onChange={(e) => setDeliveryHours(e.target.value)} inputMode="decimal" />

      <label style={label}>Inspection (hours, max 336h)</label>
      <input
        style={input}
        value={inspectionHours}
        onChange={(e) => setInspectionHours(e.target.value)}
        inputMode="decimal"
      />

      <label style={label}>Category (inspection minimums enforced)</label>
      <select value={category} onChange={(e) => setCategory(e.target.value)} style={input}>
        {CATEGORIES.map((c) => {
          const minHours = (CATEGORY_MINIMUMS[c] ?? 0) / 3_600;
          return (
            <option key={c} value={c}>
              {c} — min inspection {minHours}h
            </option>
          );
        })}
      </select>

      <label style={label}>Fee payer</label>
      <select
        value={String(feeBps)}
        onChange={(e) => setFeeBps(Number(e.target.value) as 0 | 5_000 | 10_000)}
        style={input}
      >
        {FEE_ALLOCATIONS.map((f) => (
          <option key={f.bps} value={String(f.bps)}>
            {f.label}
          </option>
        ))}
      </select>

      <label style={label}>Agreement description (hashed into agreementHash)</label>
      <textarea style={{ ...input, minHeight: 80 }} value={description} onChange={(e) => setDescription(e.target.value)} />

      <div style={card}>
        <h3>Chain binding</h3>
        <label style={label}>Hub address</label>
        <input style={input} value={hub} onChange={(e) => setHub(e.target.value)} placeholder="0x…" />
        <label style={label}>USDC token address</label>
        <input style={input} value={token} onChange={(e) => setToken(e.target.value)} placeholder="0x…" />
        <p style={{ fontSize: 13 }}>Chain ID: {CHAIN_ID}</p>
      </div>

      <div style={card}>
        <h3>Live exact preview</h3>
        {"error" in preview || !preview.principalUnits ? (
          <div style={error}>{preview && "error" in preview ? preview.error : "Enter valid amounts."}</div>
        ) : (
          <ul>
            <li>Principal: {formatUSDC(preview.principalUnits)}</li>
            <li>Quoted platform fee: {formatUSDC(preview.quoted)}</li>
            <li>Buyer prepaid fee share: {formatUSDC(preview.prepaid)}</li>
            <li>
              <strong>Total funding (exact): {formatUSDC(preview.funded)}</strong>
            </li>
          </ul>
        )}
      </div>

      {defaultsError ? <div style={warning}>{defaultsError}</div> : null}
      {defaults ? (
        <div style={card}>
          <h3>Verified agreement binding (from /config/deal-defaults)</h3>
          <ul style={{ fontSize: 13 }}>
            <li>
              hub <span style={mono}>{describeAgreement(defaults).hub}</span> · USDC{" "}
              <span style={mono}>{describeAgreement(defaults).token}</span> · chainId{" "}
              {describeAgreement(defaults).chainId}
            </li>
            <li>
              platform fee recipient <span style={mono}>{defaults.platformFeeRecipient}</span> · arbitration cost
              recipient <span style={mono}>{defaults.arbitrationCostRecipient}</span>
            </li>
            {describeAgreement(defaults).policies.map((p) => (
              <li key={p.slot}>
                {p.slot}: <span style={mono}>{p.id}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {submitError ? <div style={error}>{submitError}</div> : null}
      <button type="button" style={button} disabled={submitting || !defaults} onClick={() => void submit()}>
        {submitting ? "Creating…" : "Create draft + invite link"}
      </button>
    </main>
  );
}
