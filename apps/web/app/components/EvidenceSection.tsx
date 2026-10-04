"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../../lib/api";
import type { RequestSigner } from "../../lib/requestAuth";
import {
  EVIDENCE_CUTOFF_COPY,
  NO_CREDENTIALS_UPLOAD_COPY,
  REVIEWER_PENDING_COPY,
  downloadEvidence,
  fetchExportBundle,
  fetchManifest,
  fetchReceipt,
  fileToBytes,
  isAccessDenied,
  isEndpointMissing,
  prescreenSecrets,
  postRestoreCheck,
  shortHash,
  uploadEvidence,
  type EvidenceManifestEntry,
} from "../../lib/evidence";
import { connectEvidenceAuth } from "./evidenceAuth";
import { button, card, error, mono, ok, secondaryButton, warning } from "./styles";

function triggerDownload(bytes: Uint8Array, filename: string, contentType: string): void {
  const blob = new Blob([bytes], { type: contentType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

type LoadStatus = "connect" | "loading" | "ready" | "missing" | "denied" | "error";

function scanLooksBad(scan: string): boolean {
  return /quarantin|infect|fail|reject|malic/i.test(scan);
}

export default function EvidenceSection({ dealId }: { dealId: string }) {
  const [status, setStatus] = useState<LoadStatus>("connect");
  const [entries, setEntries] = useState<readonly EvidenceManifestEntry[]>([]);
  const [head, setHead] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState("delivery");
  const [description, setDescription] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadOk, setUploadOk] = useState<string | null>(null);

  const [receiptView, setReceiptView] = useState<{ fileHash: string; body: string } | null>(null);
  const [receiptBusy, setReceiptBusy] = useState<string | null>(null);
  const [busyDownload, setBusyDownload] = useState<string | null>(null);
  const [exportState, setExportState] = useState<string | null>(null);
  const [restoreState, setRestoreState] = useState<string | null>(null);

  const secretHit = prescreenSecrets(`${file?.name ?? ""}\n${description}`);

  const load = useCallback(async () => {
    setLoadError(null);
    let auth: RequestSigner;
    try {
      auth = await connectEvidenceAuth();
    } catch {
      setStatus("connect");
      return;
    }
    setStatus("loading");
    try {
      const result = await fetchManifest(dealId, auth);
      setEntries(result.manifest);
      setHead(result.head);
      setStatus("ready");
    } catch (e) {
      if (isEndpointMissing(e)) {
        setStatus("missing");
      } else if (isAccessDenied(e)) {
        setStatus("denied");
      } else {
        setStatus("error");
        setLoadError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
      }
    }
  }, [dealId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function withAuth<T>(fn: (auth: RequestSigner) => Promise<T>): Promise<T> {
    return fn(await connectEvidenceAuth());
  }

  async function onUpload(): Promise<void> {
    setUploading(true);
    setUploadError(null);
    setUploadOk(null);
    try {
      if (!file) throw new Error("Choose a file first.");
      const result = await withAuth(async (auth) =>
        uploadEvidence(
          dealId,
          {
            fileName: file.name,
            contentType: file.type || "application/octet-stream",
            fileBytes: await fileToBytes(file),
            kind: kind.trim() === "" ? "delivery" : kind.trim(),
            description,
          },
          auth,
        ),
      );
      setUploadOk(
        `Uploaded seq ${result.seq}: fileHash ${result.fileHash}, commitment ${result.commitment}, scan ${result.scan}.`,
      );
      setDescription("");
      setFile(null);
      await load();
    } catch (e) {
      if (isAccessDenied(e)) {
        setUploadError(REVIEWER_PENDING_COPY);
      } else {
        setUploadError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
      }
    } finally {
      setUploading(false);
    }
  }

  async function onReceipt(entry: EvidenceManifestEntry): Promise<void> {
    setReceiptBusy(entry.fileHash);
    try {
      const receipt = await withAuth(async (auth) => fetchReceipt(entry.fileHash, dealId, auth));
      setReceiptView({ fileHash: entry.fileHash, body: JSON.stringify(receipt, null, 2) });
    } catch (e) {
      setReceiptView({
        fileHash: entry.fileHash,
        body: isAccessDenied(e) ? REVIEWER_PENDING_COPY : `Receipt fetch failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setReceiptBusy(null);
    }
  }

  async function onDownload(entry: EvidenceManifestEntry): Promise<void> {
    setBusyDownload(entry.fileHash);
    try {
      const result = await withAuth(async (auth) => downloadEvidence(entry.fileHash, dealId, auth));
      triggerDownload(result.bytes, `${entry.fileHash.slice(0, 16)}.bin`, result.contentType ?? "application/octet-stream");
    } catch (e) {
      setLoadError(isAccessDenied(e) ? REVIEWER_PENDING_COPY : `Download failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyDownload(null);
    }
  }

  async function onExport(): Promise<void> {
    setExportState("Preparing export…");
    try {
      const bundle = await withAuth(async (auth) => fetchExportBundle(dealId, auth));
      triggerDownload(new TextEncoder().encode(bundle.raw), `deal-${dealId.slice(0, 12)}-export.json`, "application/json");
      setExportState("Export downloaded.");
    } catch (e) {
      setExportState(
        isAccessDenied(e) ? REVIEWER_PENDING_COPY : `Export failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  async function onRestoreCheck(): Promise<void> {
    setRestoreState("Checking…");
    try {
      const result = await withAuth(async (auth) => postRestoreCheck(dealId, auth));
      setRestoreState(result.ok ? `Restore check ok.${result.detail ? ` ${result.detail}` : ""}` : "Restore check reported a problem.");
    } catch (e) {
      if (isEndpointMissing(e)) {
        setRestoreState("Restore-check endpoint is not deployed yet (404) — nothing was checked.");
      } else if (isAccessDenied(e)) {
        setRestoreState(REVIEWER_PENDING_COPY);
      } else {
        setRestoreState(`Restore check failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  return (
    <div style={card}>
      <h2>Evidence</h2>
      <p style={{ fontSize: 14 }}>{EVIDENCE_CUTOFF_COPY}</p>

      {status === "connect" ? (
        <div style={warning}>
          Connect your deal wallet to load evidence (requests are signed with your wallet).
          <div>
            <button type="button" style={button} onClick={() => void load()}>
              Connect + load evidence
            </button>
          </div>
        </div>
      ) : null}
      {status === "loading" ? <p>Loading evidence manifest…</p> : null}
      {status === "missing" ? (
        <div style={warning}>
          Evidence endpoints are not deployed yet (404) — the manifest, upload, and export below are unavailable.
          The on-chain delivery flow still works.
        </div>
      ) : null}
      {status === "denied" ? <div style={warning}>{REVIEWER_PENDING_COPY}</div> : null}
      {status === "error" ? <div style={error}>{loadError ?? "Failed to load evidence."}</div> : null}

      {status === "ready" ? (
        <div>
          <h3>Manifest ({entries.length})</h3>
          {head ? (
            <p style={mono}>head: {head}</p>
          ) : null}
          {entries.length === 0 ? (
            <p style={{ fontSize: 14 }}>No evidence uploaded yet.</p>
          ) : (
            <ul>
              {entries.map((entry) => (
                <li key={`${entry.seq}-${entry.fileHash}`} style={{ marginBottom: 8 }}>
                  <span style={mono}>
                    #{entry.seq} {shortHash(entry.fileHash)}
                  </span>{" "}
                  [{entry.kind}] — scan:{" "}
                  {scanLooksBad(entry.scan) ? <strong>{entry.scan}</strong> : <span>{entry.scan}</span>}
                  <br />
                  <span style={{ fontSize: 13 }}>
                    {entry.description || "(no description)"} · by <span style={mono}>{shortHash(entry.uploader)}</span> ·{" "}
                    {entry.uploadedAt}
                  </span>
                  <br />
                  <button
                    type="button"
                    style={secondaryButton}
                    disabled={receiptBusy === entry.fileHash}
                    onClick={() => void onReceipt(entry)}
                  >
                    {receiptBusy === entry.fileHash ? "Loading…" : "View receipt"}
                  </button>
                  <button
                    type="button"
                    style={secondaryButton}
                    disabled={busyDownload === entry.fileHash}
                    onClick={() => void onDownload(entry)}
                  >
                    {busyDownload === entry.fileHash ? "Loading…" : "Download"}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {receiptView ? (
            <div style={card}>
              <h4>Receipt for {shortHash(receiptView.fileHash)}</h4>
              <pre style={{ ...mono, whiteSpace: "pre-wrap" }}>{receiptView.body}</pre>
              <button type="button" style={secondaryButton} onClick={() => setReceiptView(null)}>
                Close
              </button>
            </div>
          ) : null}
          <div>
            <button type="button" style={secondaryButton} onClick={() => void load()}>
              Refresh manifest
            </button>
            <button type="button" style={secondaryButton} onClick={() => void onExport()}>
              Download export bundle
            </button>
            <button type="button" style={secondaryButton} onClick={() => void onRestoreCheck()}>
              Run restore check
            </button>
          </div>
          {exportState ? <p style={{ fontSize: 14 }}>{exportState}</p> : null}
          {restoreState ? <p style={{ fontSize: 14 }}>{restoreState}</p> : null}
        </div>
      ) : null}

      <div style={card}>
        <h3>Upload evidence</h3>
        <div style={warning}>{NO_CREDENTIALS_UPLOAD_COPY}</div>
        <label style={{ display: "block", fontSize: 14 }}>
          File (max 25 MB; executables blocked client-side):
          <input
            type="file"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            style={{ display: "block", marginTop: 4 }}
          />
        </label>
        <label style={{ display: "block", fontSize: 14, marginTop: 8 }}>
          Kind:
          <input
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            placeholder="screenshot, receipt, log…"
            style={{ display: "block", width: "100%", padding: 8, boxSizing: "border-box" }}
          />
        </label>
        <label style={{ display: "block", fontSize: 14, marginTop: 8 }}>
          Description (visible to parties/reviewers — no secrets):
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            style={{ display: "block", width: "100%", padding: 8, boxSizing: "border-box" }}
          />
        </label>
        {secretHit.hit ? (
          <div style={warning}>
            Warning: this looks like it may contain a credential ({secretHit.matched.join(", ")}). Remove secrets
            before uploading — the server scan is authoritative and this warning does not block you.
          </div>
        ) : null}
        <button type="button" style={button} disabled={uploading} onClick={() => void onUpload()}>
          {uploading ? "Uploading…" : "Sign + upload"}
        </button>
        {uploadOk ? <div style={ok}>{uploadOk}</div> : null}
        {uploadError ? <div style={error}>{uploadError}</div> : null}
      </div>
    </div>
  );
}
