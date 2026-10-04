"use client";

import { useState } from "react";
import { getRelayJob, relaySubmit } from "../../lib/api";
import {
  confirmEvent,
  encodeOpenDispute,
  getAccount,
  randomBytes32,
  sendDirect,
  signOpenDispute,
  waitForReceipt,
  type OpenDisputeIntent,
} from "../../lib/wallet";
import { button, dangerButton, error, mono, ok, secondaryButton, warning } from "./styles";
import TxStatus from "./TxStatus";

const ZERO_HASH = "0x0000000000000000000000000000000000000000000000000000000000000000";

type Phase = "idle" | "working" | "freeze-included" | "failed";

/**
 * Freeze-first dispute button. The freeze is confirmed ONLY by the exact
 * transaction receipt (status === "success") AND the DisputeOpened event for
 * this dealId in that receipt (finding #8). A relay acceptance, a relay job
 * status, or the deal's generic confirmation level is never treated as
 * "frozen". On a reverted receipt the revert reason is surfaced.
 */
export default function DisputeButton({
  dealId,
  hub,
  chainId,
  agreementDigest,
}: {
  dealId: string;
  hub: `0x${string}`;
  chainId: number;
  agreementDigest: `0x${string}`;
}) {
  const [reasonCode, setReasonCode] = useState("1");
  const [mode, setMode] = useState<"relay" | "direct">("relay");
  const [phase, setPhase] = useState<Phase>("idle");
  const [detail, setDetail] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  async function waitForRelayTxHash(key: string): Promise<`0x${string}`> {
    for (let i = 0; i < 120; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      try {
        const job = await getRelayJob(key);
        if (job.txHash) return job.txHash as `0x${string}`;
      } catch {
        // Keep waiting; the relay outbox may not have executed yet.
      }
    }
    throw new Error("Relay did not surface a transaction hash in time. Verify the relay job before retrying.");
  }

  async function freeze() {
    setFailure(null);
    setDetail("");
    setPhase("working");
    try {
      const actor = await getAccount();
      const intent: OpenDisputeIntent = {
        dealId: dealId as `0x${string}`,
        agreementDigest,
        actor,
        reasonCode: Number(reasonCode),
        initialCommitment: ZERO_HASH as `0x${string}`,
        nonce: randomBytes32(),
        expiresAt: BigInt(Math.floor(Date.now() / 1_000) + 3_600),
      };
      setDetail("Signing freeze intent with wallet…");
      const sig = await signOpenDispute(hub, chainId, intent);

      let hash: `0x${string}`;
      if (mode === "relay") {
        setDetail("Submitting freeze to sponsored relay… (a relay acceptance is not inclusion)");
        const key = `dispute-${dealId.slice(0, 10)}-${Date.now()}`;
        const job = await relaySubmit(key, "openDispute", {
          dealId,
          reasonCode: intent.reasonCode,
          initialCommitment: intent.initialCommitment,
          nonce: intent.nonce,
          expiresAt: intent.expiresAt.toString(),
          sig,
        });
        setDetail(`Relay accepted (${job.status}). Waiting for the relayer transaction hash…`);
        hash = await waitForRelayTxHash(key);
      } else {
        setDetail("Sending freeze directly from wallet…");
        const data = encodeOpenDispute(
          intent.dealId,
          intent.reasonCode,
          intent.initialCommitment,
          intent.nonce,
          intent.expiresAt,
          sig,
        );
        hash = await sendDirect(hub, data);
      }

      setTxHash(hash);
      setDetail(`Tx ${hash} submitted. Waiting for the exact receipt…`);
      const receipt = await waitForReceipt(hash);
      confirmEvent(receipt, hub, "DisputeOpened", (args) => {
        return String(args["dealId"]).toLowerCase() === dealId.toLowerCase();
      });
      setPhase("freeze-included");
      setDetail(
        `DisputeOpened confirmed in tx ${hash} for this deal. Funds are frozen — gathering evidence comes second.`,
      );
    } catch (e) {
      setPhase("failed");
      setFailure(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div>
      <div style={warning}>
        <strong>One free freeze per deal.</strong> Opening a dispute permanently consumes the deal&apos;s single
        dispute (`DisputeExhausted` afterwards). Escalation later requires a real 5 USDC-minimum bond. Freeze first,
        gather evidence second.
      </div>
      {phase !== "freeze-included" ? (
        <div>
          <label style={{ display: "block", fontSize: 14 }}>
            Reason code (uint8){" "}
            <input
              value={reasonCode}
              onChange={(e) => setReasonCode(e.target.value)}
              style={{ width: 80, padding: 6 }}
              inputMode="numeric"
            />
          </label>
          <label style={{ display: "block", fontSize: 14, marginTop: 8 }}>
            Submission path{" "}
            <select value={mode} onChange={(e) => setMode(e.target.value as "relay" | "direct")}>
              <option value="relay">Sponsored relay</option>
              <option value="direct">Direct wallet send (no relayer)</option>
            </select>
          </label>
          <button type="button" onClick={freeze} disabled={phase === "working"} style={dangerButton}>
            {phase === "working" ? "Freezing…" : "DISPUTE — freeze first"}
          </button>
          {phase === "working" ? <TxStatus level="pending" txHash={txHash} /> : null}
          {detail ? <p style={{ fontSize: 14 }}>{detail}</p> : null}
        </div>
      ) : (
        <div style={ok}>
          <p>
            <strong>Step 1 complete: freeze confirmed by receipt + DisputeOpened.</strong>{" "}
            <TxStatus level="included" txHash={txHash} />
          </p>
          <p style={{ fontSize: 14 }}>
            <strong>Step 2 — evidence guidance.</strong> Phase 8 evidence upload is upcoming: preserve originals
            (files, chat exports, tracking records) with their timestamps. Do not edit originals; keep a private
            copy. Do not post private evidence in public channels. When the upload panel opens, commit file hashes in
            order — the on-chain commitment, not the file, is what the freeze points at.
          </p>
          {txHash ? <p style={mono}>freeze tx: {txHash}</p> : null}
        </div>
      )}
      {phase === "failed" && failure ? (
        <div style={error}>
          Freeze failed: {failure}
          <div style={{ marginTop: 8 }}>
            <button type="button" onClick={() => setPhase("idle")} style={secondaryButton}>
              Back
            </button>
            <button type="button" onClick={freeze} style={button}>
              Retry freeze
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
