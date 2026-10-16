"use client";

// Seller delivery: describe what was delivered (category form, or a plain
// note), then mark the deal delivered on chain. Only a fingerprint (hash) of
// the delivery record goes on chain; marking delivered starts the buyer's
// inspection clock.

import { use, useReducer, useState } from "react";
import { keccak256, stringToHex, type Hash } from "viem";
import { relaySubmit } from "../../../../lib/api";
import { encodeMarkDelivered, getAccount, randomBytes32, sendDirect, signDeliver, waitForInclusion } from "../../../../lib/wallet";
import {
  DeliveryFormError,
  NO_CREDENTIALS_DELIVERY_COPY,
  createInitialDeliveryForm,
  deliveryFormReducer,
  fetchCategories,
  isEndpointMissing,
  prescreenSecrets,
  submitDeliveryForm,
  validateDeliveryForm,
  type CategoryDef,
} from "../../../../lib/evidence";
import { formatSpan, formatUnixDate } from "../../../../lib/money";
import { friendlyError } from "../../../../lib/errors";
import { useDeal } from "../../../components/useDeal";
import { useSession } from "../../../components/useSession";
import { connectEvidenceAuth } from "../../../components/evidenceAuth";
import DealShell, { chainPhaseOf, roleOf } from "../../../components/DealShell";
import Countdown from "../../../components/Countdown";
import { Button, ButtonLink, Callout, Card, Field } from "../../../components/ui";

const EXPLORER = process.env["NEXT_PUBLIC_EXPLORER_URL"] ?? "https://basescan.org";

export default function DeliverPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = use(params);
  const id = decodeURIComponent(rawId);
  const view = useDeal(id);
  const { session, ensureWallet } = useSession();

  const [mode, setMode] = useState<"choose" | "form" | "note">("choose");
  const [category, setCategory] = useState<CategoryDef | null>(null);
  const [form, dispatch] = useReducer(deliveryFormReducer, createInitialDeliveryForm());
  const [note, setNote] = useState("");
  const [manifest, setManifest] = useState<Hash | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const role = roleOf(view, session?.wallet);
  const phase = chainPhaseOf(view);
  const terms = view.terms;
  const digest = terms?.["agreementDigest"] as Hash | undefined;
  const deliveryDeadline =
    view.dealStatus?.fundedAt && terms ? Number(view.dealStatus.fundedAt) + Number(terms.deliverySeconds) : null;

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

  async function openForm() {
    await ensureWallet();
    const auth = await connectEvidenceAuth();
    try {
      const categories = await fetchCategories(auth);
      const match = categories.find((c) => c.id === terms?.category) ?? categories[0] ?? null;
      if (!match) throw new Error("No delivery form is available for this category.");
      setCategory(match);
      dispatch({ type: "init" });
      setMode("form");
    } catch (e) {
      if (isEndpointMissing(e)) {
        setMode("note");
        return;
      }
      throw e;
    }
  }

  async function submitForm() {
    if (!category || !view.dealId) return;
    const errors = validateDeliveryForm(category, form.values);
    dispatch({ type: "validate", category });
    if (Object.keys(errors).length > 0) return;
    try {
      const result = await submitDeliveryForm(view.dealId, category.id, form.values, await connectEvidenceAuth());
      setManifest(result.deliveryManifestHash as Hash);
    } catch (e) {
      if (e instanceof DeliveryFormError) {
        dispatch({ type: "serverErrors", errors: e.errors });
        return;
      }
      throw e;
    }
  }

  function useNote() {
    const text = note.trim();
    if (text.length < 10) throw new Error("Describe the delivery in a sentence or two.");
    setManifest(keccak256(stringToHex(text)));
  }

  async function signIntent() {
    if (!terms || !view.dealId || !manifest) throw new Error("Describe the delivery first.");
    if (!digest) throw new Error("Deal data is incomplete. Reload the page.");
    await ensureWallet();
    const account = await getAccount();
    if (account.toLowerCase() !== terms.seller.toLowerCase()) throw new Error("Switch your wallet to the seller address on this deal.");
    const nonce = randomBytes32();
    const expiresAt = BigInt(Math.floor(Date.now() / 1_000) + 3_600);
    const sig = await signDeliver(terms.hub as Hash, Number(terms.chainId), {
      dealId: view.dealId as Hash,
      agreementDigest: digest,
      actor: terms.seller as Hash,
      manifestHash: manifest,
      nonce,
      expiresAt,
    });
    return { nonce, expiresAt, sig };
  }

  async function markRelayed() {
    const { nonce, expiresAt, sig } = await signIntent();
    const res = await relaySubmit(`deliver-${view.dealId!.slice(2, 14)}-${Date.now()}`, "markDelivered", {
      dealId: view.dealId,
      manifestHash: manifest,
      nonce,
      expiresAt: expiresAt.toString(),
      sig,
    });
    setPending(null);
    setDone(`Submitted (${res.status}). The deal page updates once it lands on Base, usually within a minute.`);
  }

  async function markDirect() {
    const { nonce, expiresAt, sig } = await signIntent();
    const hash = await sendDirect(terms!.hub as Hash, encodeMarkDelivered(view.dealId as Hash, manifest!, nonce, expiresAt, sig));
    setPending("Waiting for inclusion…");
    await waitForInclusion(hash);
    setPending(null);
    setDone(`Delivered on chain. View the transaction: ${EXPLORER}/tx/${hash}`);
  }

  const back = `/deals/${encodeURIComponent(id)}`;
  const secretHit = prescreenSecrets([note, ...Object.values(form.values)].join("\n"));

  return (
    <DealShell
      id={id}
      view={view}
      title="Mark as delivered"
      subtitle={terms ? `The buyer then has ${formatSpan(Number(terms.inspectionSeconds))} to inspect before payment releases automatically.` : undefined}
    >
      {role !== "seller" ? (
        <Callout tone="neutral">Only the seller marks a deal delivered.</Callout>
      ) : phase !== "AWAITING_DELIVERY" ? (
        <Callout tone="info">
          {phase ? "This deal is past the delivery step." : "The buyer hasn't funded the escrow yet. Deliver only after it's funded."}
        </Callout>
      ) : done ? (
        <Card>
          <Callout tone="success" title="Delivery recorded">
            {done}
          </Callout>
          <div style={{ marginTop: 12 }}>
            <ButtonLink href={back}>Back to the deal</ButtonLink>
          </div>
        </Card>
      ) : (
        <>
          {deliveryDeadline ? (
            <Callout tone="warning">
              Mark delivery before {formatUnixDate(deliveryDeadline)} (<Countdown targetUnix={String(deliveryDeadline)} />). After
              that the buyer can take a full refund.
            </Callout>
          ) : null}

          <Card title="1. Describe the delivery">
            <Callout tone="neutral">{NO_CREDENTIALS_DELIVERY_COPY}</Callout>
            {manifest ? (
              <div style={{ marginTop: 12 }}>
                <Callout tone="success">Delivery record saved. Its fingerprint will be recorded on chain.</Callout>
              </div>
            ) : mode === "choose" ? (
              <div className="row" style={{ marginTop: 12 }}>
                <Button disabled={busy !== null} onClick={() => void run("form", openForm)}>
                  {busy === "form" ? "Opening…" : "Fill in the delivery form"}
                </Button>
                <Button variant="ghost" onClick={() => setMode("note")}>
                  Write a short note instead
                </Button>
              </div>
            ) : mode === "form" && category ? (
              <div className="stack" style={{ marginTop: 12 }}>
                <p className="small muted" style={{ margin: 0 }}>
                  Done means: {category.completionCriteria}
                </p>
                {category.fields.map((field) => (
                  <Field key={field.name} label={`${field.label}${field.required ? "" : " (optional)"}`} error={form.errors[field.name]}>
                    {field.type === "textarea" ? (
                      <textarea
                        value={form.values[field.name] ?? ""}
                        maxLength={field.maxLen}
                        placeholder={field.placeholder}
                        onChange={(e) => dispatch({ type: "set", name: field.name, value: e.target.value })}
                      />
                    ) : field.type === "select" ? (
                      <select value={form.values[field.name] ?? ""} onChange={(e) => dispatch({ type: "set", name: field.name, value: e.target.value })}>
                        <option value="">Select…</option>
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
                      />
                    )}
                  </Field>
                ))}
                {form.serverErrors.length > 0 ? <Callout tone="danger">{form.serverErrors.join(" ")}</Callout> : null}
                <Button disabled={busy !== null} onClick={() => void run("submit", submitForm)}>
                  {busy === "submit" ? "Saving…" : "Save delivery record"}
                </Button>
              </div>
            ) : (
              <div className="stack" style={{ marginTop: 12 }}>
                <Field label="What did you deliver, and how?" hint="Only its fingerprint goes on chain. Keep a copy: you may need it if there's a dispute.">
                  <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2_000} />
                </Field>
                <Button disabled={busy !== null} onClick={() => void run("note", async () => useNote())}>
                  Use this note
                </Button>
              </div>
            )}
            {secretHit.hit ? (
              <div style={{ marginTop: 12 }}>
                <Callout tone="warning">
                  This looks like it contains a password or secret ({secretHit.matched.join(", ")}). Remove it: never share
                  credentials here.
                </Callout>
              </div>
            ) : null}
          </Card>

          <Card title="2. Mark as delivered">
            <div className="row">
              <Button size="lg" disabled={!manifest || busy !== null} onClick={() => void run("relay", markRelayed)}>
                {busy === "relay" ? "Check your wallet…" : "Mark as delivered"}
              </Button>
              <Button variant="ghost" disabled={!manifest || busy !== null} onClick={() => void run("direct", markDirect)}>
                Send from my wallet instead
              </Button>
            </div>
            <p className="small muted" style={{ marginTop: 8, marginBottom: 0 }}>
              You sign once; Midman submits it and pays the gas.
            </p>
          </Card>
          {pending ? <Callout tone="info">{pending}</Callout> : null}
          {failure ? <Callout tone="danger">{failure}</Callout> : null}
        </>
      )}
    </DealShell>
  );
}
