"use client";

import { use, useEffect, useReducer, useState } from "react";
import { relaySubmit, ApiError, RELAY_ACTIONS } from "../../../../lib/api";
import { isHex32 } from "../../../../lib/deal";
import {
  CHAIN_ID,
  HUB_ADDRESS,
  encodeMarkDelivered,
  getAccount,
  randomBytes32,
  sendDirect,
  signDeliver,
  waitForInclusion,
} from "../../../../lib/wallet";
import {
  DeliveryFormError,
  EVIDENCE_CUTOFF_COPY,
  NO_CREDENTIALS_DELIVERY_COPY,
  REVIEWER_PENDING_COPY,
  createInitialDeliveryForm,
  deliveryFormReducer,
  fetchCategories,
  isAccessDenied,
  isEndpointMissing,
  prescreenSecrets,
  submitDeliveryForm,
  validateDeliveryForm,
  type CategoryDef,
} from "../../../../lib/evidence";
import { useDeal } from "../../../components/useDeal";
import { connectEvidenceAuth, copyToClipboard } from "../../../components/evidenceAuth";
import FallbackNotice from "../../../components/FallbackNotice";
import TxStatus from "../../../components/TxStatus";
import { button, card, error, mono, nav, ok, page, secondaryButton, warning } from "../../../components/styles";

const ZERO_HASH = "0x0000000000000000000000000000000000000000000000000000000000000000";

type CategoryStatus = "idle" | "connect" | "loading" | "ready" | "missing" | "denied" | "error";

export default function DeliverPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const rawId = decodeURIComponent(id);
  const view = useDeal(rawId);
  const [manifest, setManifest] = useState("");
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [included, setIncluded] = useState(false);
  const [copied, setCopied] = useState(false);

  const [catStatus, setCatStatus] = useState<CategoryStatus>("idle");
  const [catError, setCatError] = useState<string | null>(null);
  const [categories, setCategories] = useState<readonly CategoryDef[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [form, dispatch] = useReducer(deliveryFormReducer, createInitialDeliveryForm());
  const [formWorking, setFormWorking] = useState(false);
  const [formNotice, setFormNotice] = useState<string | null>(null);
  const [formHash, setFormHash] = useState<string | null>(null);

  const relaySupported = RELAY_ACTIONS.includes("markDelivered");
  const selected = categories.find((c) => c.id === selectedId) ?? null;
  const formSecretHit = prescreenSecrets(Object.values(form.values).join("\n"));

  useEffect(() => {
    if (view.loading || !view.terms) return;
    let cancelled = false;
    async function loadCategories(): Promise<void> {
      setCatStatus("loading");
      setCatError(null);
      let auth;
      try {
        auth = await connectEvidenceAuth();
      } catch {
        if (!cancelled) setCatStatus("connect");
        return;
      }
      try {
        const cats = await fetchCategories(auth);
        if (cancelled) return;
        setCategories(cats);
        const draftCategory = view.terms?.category ?? "";
        const first = cats[0];
        setSelectedId(cats.some((c) => c.id === draftCategory) ? draftCategory : (first ? first.id : ""));
        dispatch({ type: "init" });
        setCatStatus("ready");
      } catch (e) {
        if (cancelled) return;
        if (isEndpointMissing(e)) {
          setCatStatus("missing");
        } else if (isAccessDenied(e)) {
          setCatStatus("denied");
        } else {
          setCatStatus("error");
          setCatError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
        }
      }
    }
    void loadCategories();
    return () => {
      cancelled = true;
    };
  }, [view.loading, view.terms]);

  async function submitDelivery(): Promise<void> {
    if (!selected) return;
    const errors = validateDeliveryForm(selected, form.values);
    dispatch({ type: "validate", category: selected });
    if (Object.keys(errors).length > 0) return;
    setFormWorking(true);
    setFormNotice(null);
    try {
      const auth = await connectEvidenceAuth();
      if (!view.dealId) throw new Error("Terms not loaded");
      const result = await submitDeliveryForm(view.dealId, selected.id, form.values, auth);
      setManifest(result.deliveryManifestHash);
      setFormHash(result.deliveryManifestHash);
      setCopied(false);
    } catch (e) {
      if (e instanceof DeliveryFormError) {
        dispatch({ type: "serverErrors", errors: e.errors });
      } else if (isEndpointMissing(e)) {
        setCatStatus("missing");
      } else if (isAccessDenied(e)) {
        setFormNotice(REVIEWER_PENDING_COPY);
      } else {
        setFormNotice(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
      }
    } finally {
      setFormWorking(false);
    }
  }

  async function buildIntent() {
    if (!view.terms || !view.dealId) throw new Error("Terms not loaded");
    if (!isHex32(manifest)) throw new Error("Manifest must be a 0x bytes32 hash");
    const seller = view.terms.seller as `0x${string}`;
    const account = await getAccount();
    if (account.toLowerCase() !== seller.toLowerCase()) {
      throw new Error(`Connected wallet ${account} is not the seller (${seller})`);
    }
    const hub = (view.terms.hub ?? HUB_ADDRESS) as `0x${string}`;
    const chainId = Number(view.terms.chainId ?? CHAIN_ID);
    const nonce = randomBytes32();
    const expiresAt = BigInt(Math.floor(Date.now() / 1_000) + 3_600);
    const sig = await signDeliver(hub, chainId, {
      dealId: view.dealId as `0x${string}`,
      agreementDigest: (view.terms.agreementHash ?? ZERO_HASH) as `0x${string}`,
      actor: seller,
      manifestHash: manifest as `0x${string}`,
      nonce,
      expiresAt,
    });
    return { hub, nonce, expiresAt, sig };
  }

  async function directSend() {
    setWorking(true);
    setMessage(null);
    setFailure(null);
    setIncluded(false);
    try {
      const { hub, nonce, expiresAt, sig } = await buildIntent();
      if (!view.dealId) throw new Error("Terms not loaded");
      const data = encodeMarkDelivered(view.dealId as `0x${string}`, manifest as `0x${string}`, nonce, expiresAt, sig);
      const hash = await sendDirect(hub, data);
      setTxHash(hash);
      setMessage(`Direct delivery tx sent (${hash}) — pending, not included.`);
      await waitForInclusion(hash);
      setIncluded(true);
      setMessage(`Delivery included (${hash}). Inspection clock is now running.`);
    } catch (e) {
      setFailure(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  }

  async function relaySend() {
    setWorking(true);
    setMessage(null);
    setFailure(null);
    try {
      const { nonce, expiresAt, sig } = await buildIntent();
      if (!view.dealId) throw new Error("Terms not loaded");
      const key = `deliver-${view.dealId.slice(0, 12)}-${Date.now()}`;
      const res = await relaySubmit(key, "markDelivered", {
        dealId: view.dealId,
        manifestHash: manifest,
        nonce,
        expiresAt: expiresAt.toString(),
        sig,
      });
      setMessage(`Relay ${res.status} (key ${res.idempotencyKey}) — pending until included.`);
    } catch (e) {
      setFailure(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  }

  async function copyManifest() {
    setCopied(await copyToClipboard(manifest));
  }

  if (view.loading) {
    return (
      <main style={page}>
        <p>Loading delivery panel…</p>
      </main>
    );
  }
  if (!view.terms) {
    return (
      <main style={page}>
        <h1>Deliver</h1>
        <div style={error}>{view.error ?? "Draft not loaded."}</div>
        <p style={nav}>
          <a href={`/deals/${id}`}>← Dashboard</a>
        </p>
      </main>
    );
  }

  return (
    <main style={page}>
      <h1>Deliver (seller)</h1>
      <p style={nav}>
        <a href={`/deals/${id}`}>← Dashboard</a>
      </p>

      {!relaySupported ? (
        <div style={warning}>
          API gap: the relay allowlist does not include <span style={mono}>markDelivered</span>. Relay submission
          below will be rejected by the API (surfaced as an error); the direct wallet path is fully available.
        </div>
      ) : null}

      <div style={card}>
        <h2>Delivery form</h2>
        <p style={{ fontSize: 14 }}>{EVIDENCE_CUTOFF_COPY}</p>
        <div style={warning}>{NO_CREDENTIALS_DELIVERY_COPY}</div>

        {catStatus === "idle" || catStatus === "loading" ? <p>Loading category form…</p> : null}
        {catStatus === "connect" ? (
          <div style={warning}>
            Connect your seller wallet to load the category delivery form (requests are signed with your wallet).
            You can also use the manual manifest hash below.
            <div>
              <button
                type="button"
                style={button}
                onClick={() => {
                  setCatStatus("idle");
                  window.location.reload();
                }}
              >
                Connect + retry
              </button>
            </div>
          </div>
        ) : null}
        {catStatus === "missing" ? (
          <div style={warning}>
            Delivery-form endpoints are not deployed yet (404) — fill in the manifest hash manually below.
          </div>
        ) : null}
        {catStatus === "denied" ? <div style={warning}>{REVIEWER_PENDING_COPY}</div> : null}
        {catStatus === "error" ? <div style={error}>{catError ?? "Failed to load categories."}</div> : null}

        {catStatus === "ready" && selected ? (
          <div>
            <label style={{ display: "block", fontSize: 14 }}>
              Category (draft: {view.terms.category}):
              <select
                value={selectedId}
                onChange={(e) => {
                  setSelectedId(e.target.value);
                  dispatch({ type: "init" });
                  setFormHash(null);
                }}
                style={{ display: "block", width: "100%", padding: 8, marginTop: 4 }}
              >
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.id} (min inspection {c.minInspection}s)
                  </option>
                ))}
              </select>
            </label>
            <p style={{ fontSize: 14 }}>Completion criteria: {selected.completionCriteria}</p>
            {selected.fields.map((field) => (
              <label key={field.name} style={{ display: "block", fontSize: 14, marginTop: 8 }}>
                {field.label}
                {field.required ? " *" : ""}:
                {field.type === "textarea" ? (
                  <textarea
                    value={form.values[field.name] ?? ""}
                    maxLength={field.maxLen}
                    placeholder={field.placeholder}
                    onChange={(e) => dispatch({ type: "set", name: field.name, value: e.target.value })}
                    rows={3}
                    style={{ display: "block", width: "100%", padding: 8, boxSizing: "border-box" }}
                  />
                ) : field.type === "select" ? (
                  <select
                    value={form.values[field.name] ?? ""}
                    onChange={(e) => dispatch({ type: "set", name: field.name, value: e.target.value })}
                    style={{ display: "block", width: "100%", padding: 8, marginTop: 4 }}
                  >
                    <option value="">— select —</option>
                    {(field.options ?? []).map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={form.values[field.name] ?? ""}
                    maxLength={field.maxLen}
                    placeholder={field.placeholder}
                    type={field.type === "date" ? "date" : field.type === "number" ? "number" : "text"}
                    onChange={(e) => dispatch({ type: "set", name: field.name, value: e.target.value })}
                    style={{ display: "block", width: "100%", padding: 8, boxSizing: "border-box" }}
                  />
                )}
                {form.errors[field.name] ? <span style={{ color: "#8f1d1d" }}>{form.errors[field.name]}</span> : null}
              </label>
            ))}
            {formSecretHit.hit ? (
              <div style={warning}>
                Warning: this looks like it may contain a credential ({formSecretHit.matched.join(", ")}). Remove
                secrets before submitting.
              </div>
            ) : null}
            {form.serverErrors.length > 0 ? (
              <div style={error}>
                <ul>
                  {form.serverErrors.map((err) => (
                    <li key={err}>{err}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <button type="button" style={button} disabled={formWorking} onClick={() => void submitDelivery()}>
              {formWorking ? "Submitting…" : "Submit delivery form"}
            </button>
            {formHash ? (
              <div style={ok}>
                Delivery manifest hash: <span style={mono}>{formHash}</span>
                <div>
                  <button type="button" style={secondaryButton} onClick={() => void copyManifest()}>
                    {copied ? "Copied!" : "Copy hash"}
                  </button>
                </div>
                <p style={{ fontSize: 14 }}>
                  The hash is filled into the manifest field below — proceed with direct or relay delivery.
                </p>
              </div>
            ) : null}
            {formNotice ? <div style={error}>{formNotice}</div> : null}
          </div>
        ) : null}
      </div>

      <div style={card}>
        <h2>Delivery manifest hash</h2>
        <p style={{ fontSize: 14 }}>
          Commit the bytes32 hash of your delivery manifest (e.g. keccak of the file bundle). The hash — not the
          file — is recorded on-chain.
        </p>
        <input
          value={manifest}
          onChange={(e) => setManifest(e.target.value)}
          placeholder="0x… (64 hex chars)"
          style={{ width: "100%", padding: 8, boxSizing: "border-box" }}
        />
        <div>
          <button type="button" style={button} disabled={working} onClick={() => void directSend()}>
            {working ? "Working…" : "Direct wallet: sign + send delivery"}
          </button>
          <button type="button" style={secondaryButton} disabled={working} onClick={() => void relaySend()}>
            Relay: submit delivery
          </button>
        </div>
        {txHash ? (
          <p>
            <TxStatus level={included ? "included" : "pending"} txHash={txHash} />
          </p>
        ) : null}
      </div>

      {message ? <div style={ok}>{message}</div> : null}
      {failure ? <div style={error}>{failure}</div> : null}

      {view.dealId ? <FallbackNotice dealId={view.dealId} /> : null}
    </main>
  );
}
