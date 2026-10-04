// EvidenceManifest signing payloads (specs/phase2-threat-model.md section 2).
// Pure builders + validation: no Store, no network. Route wiring lives in
// categories/routes.ts.
import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbiParameters, type Hex } from "viem";
import { EIP712_DOMAIN, HUB_ABI, TYPES as EIP712_TYPES, evidenceFilesHash } from "@midman/chain";

export const EIP712_EVIDENCE_DOMAIN = EIP712_DOMAIN;

/**
 * EIP-712 types for EvidenceManifest — the canonical @midman/chain
 * definition, EXACTLY per the frozen threat-model schema: dealId,
 * agreementDigest, uploader, sequence, prevCommitment, fileHashes,
 * metadataCommitment, nonce, expiresAt. Field order is signing-significant.
 */
export const EVIDENCE_MANIFEST_TYPES = {
  EvidenceManifest: EIP712_TYPES.EvidenceManifest,
} as const;

export const EVIDENCE_MANIFEST_FIELD_ORDER: readonly string[] = EVIDENCE_MANIFEST_TYPES.EvidenceManifest.map(
  (field) => field.name,
);

export interface ParsedCommitmentInput {
  readonly uploader: string;
  readonly sequence: number;
  readonly prevCommitment: string;
  readonly fileHashes: string[];
  readonly metadataCommitment: string;
  readonly nonce: string;
  readonly expiresAt: number;
}

const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const UINT32_MAX = 4_294_967_295;

/** Validate the /evidence/payload body: hex shapes + integer ranges. */
export function validateCommitmentInput(body: unknown):
  | { ok: true; value: ParsedCommitmentInput }
  | { ok: false; errors: string[] } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, errors: ["Body must be an object"] };
  }
  const record = body as Record<string, unknown>;
  const errors: string[] = [];

  const uploader = record["uploader"];
  if (typeof uploader !== "string" || !ADDRESS_RE.test(uploader)) {
    errors.push('Field "uploader" must be an address');
  }
  const sequence = record["sequence"];
  const sequenceOk =
    typeof sequence === "number"
      ? Number.isInteger(sequence)
      : typeof sequence === "string" && /^[0-9]+$/.test(sequence);
  if (!sequenceOk) errors.push('Field "sequence" must be an integer');
  const prevCommitment = record["prevCommitment"];
  if (typeof prevCommitment !== "string" || !BYTES32_RE.test(prevCommitment)) {
    errors.push('Field "prevCommitment" must be bytes32');
  }
  const fileHashes = record["fileHashes"];
  if (
    !Array.isArray(fileHashes) ||
    fileHashes.some((entry) => typeof entry !== "string" || !BYTES32_RE.test(entry))
  ) {
    errors.push('Field "fileHashes" must be an array of bytes32');
  }
  const metadataCommitment = record["metadataCommitment"];
  if (typeof metadataCommitment !== "string" || !BYTES32_RE.test(metadataCommitment)) {
    errors.push('Field "metadataCommitment" must be bytes32');
  }
  const nonce = record["nonce"];
  if (typeof nonce !== "string" || !BYTES32_RE.test(nonce)) {
    errors.push('Field "nonce" must be bytes32');
  }
  const expiresAt = record["expiresAt"];
  const expiresOk =
    typeof expiresAt === "number"
      ? Number.isInteger(expiresAt)
      : typeof expiresAt === "string" && /^[0-9]+$/.test(expiresAt);
  if (!expiresOk) errors.push('Field "expiresAt" must be an integer');

  if (errors.length > 0) return { ok: false, errors };

  const sequenceNum = Number(sequence);
  const expiresNum = Number(expiresAt);
  const rangeErrors: string[] = [];
  if (sequenceNum < 0 || sequenceNum > UINT32_MAX) rangeErrors.push('Field "sequence" out of uint32 range');
  if (expiresNum <= Math.floor(Date.now() / 1_000)) rangeErrors.push('Field "expiresAt" must be in the future');
  if (rangeErrors.length > 0) return { ok: false, errors: rangeErrors };

  return {
    ok: true,
    value: {
      uploader: uploader as string,
      sequence: sequenceNum,
      prevCommitment: prevCommitment as string,
      fileHashes: fileHashes as string[],
      metadataCommitment: metadataCommitment as string,
      nonce: nonce as string,
      expiresAt: expiresNum,
    },
  };
}

export interface EvidenceManifestTypedData {
  readonly domain: { name: string; version: string; chainId: number; verifyingContract: string };
  readonly types: typeof EVIDENCE_MANIFEST_TYPES;
  readonly primaryType: "EvidenceManifest";
  readonly message: {
    readonly dealId: string;
    readonly agreementDigest: string;
    readonly uploader: string;
    readonly sequence: string;
    readonly prevCommitment: string;
    readonly fileHashes: string[];
    readonly metadataCommitment: string;
    readonly nonce: string;
    readonly expiresAt: string;
  };
}

/** Build the EIP-712 typed-data envelope (uint fields as decimal strings, same convention as readiness-payload). */
export function buildEvidenceManifestTypedData(args: {
  chainId: number;
  hub: string;
  dealId: string;
  agreementDigest: string;
  input: ParsedCommitmentInput;
}): EvidenceManifestTypedData {
  return {
    domain: {
      name: EIP712_EVIDENCE_DOMAIN.name,
      version: EIP712_EVIDENCE_DOMAIN.version,
      chainId: args.chainId,
      verifyingContract: args.hub,
    },
    types: EVIDENCE_MANIFEST_TYPES,
    primaryType: "EvidenceManifest",
    message: {
      dealId: args.dealId,
      agreementDigest: args.agreementDigest,
      uploader: args.input.uploader,
      sequence: String(args.input.sequence),
      prevCommitment: args.input.prevCommitment,
      fileHashes: [...args.input.fileHashes],
      metadataCommitment: args.input.metadataCommitment,
      nonce: args.input.nonce,
      expiresAt: String(args.input.expiresAt),
    },
  };
}

/**
 * Pre-encode submitEvidenceCommitment calldata (sig slot left as 0x: the
 * uploader signs the typed-data above separately, then submits with the sig).
 */
export function encodeSubmitEvidenceCommitmentCalldata(args: {
  dealId: string;
  input: ParsedCommitmentInput;
  sig?: string;
}): Hex {
  return encodeFunctionData({
    abi: HUB_ABI,
    functionName: "submitEvidenceCommitment",
    args: [
      args.dealId as Hex,
      args.input.uploader as Hex,
      args.input.sequence,
      args.input.prevCommitment as Hex,
      args.input.fileHashes as Hex[],
      args.input.metadataCommitment as Hex,
      args.input.nonce as Hex,
      BigInt(args.input.expiresAt),
      ((args.sig ?? "0x") as Hex),
    ],
  });
}

const MANIFEST_PARAMS = parseAbiParameters(
  "bytes32 dealId, bytes32 agreementDigest, address uploader, uint32 sequence, bytes32 prevCommitment, bytes32 filesHash, bytes32 metadataCommitment",
);

/**
 * Off-chain manifest commitment hash:
 *   filesHash  = keccak256 over the raw concatenation of the file hashes
 *                (canonical evidenceFilesHash — byte-equivalent to the
 *                contract's keccak256(abi.encodePacked(fileHashes)))
 *   commitment = keccak256(abi.encode(dealId, agreementDigest, uploader,
 *                          sequence, prevCommitment, filesHash, metadataCommitment))
 * This mirrors the on-chain append-only manifest chaining (prevCommitment links
 * submissions); the contract remains authoritative at submitEvidenceCommitment.
 */
export function evidenceManifestCommitment(args: {
  dealId: string;
  agreementDigest: string;
  input: ParsedCommitmentInput;
}): Hex {
  const filesHash = evidenceFilesHash(args.input.fileHashes as Hex[]);
  return keccak256(
    encodeAbiParameters(MANIFEST_PARAMS, [
      args.dealId as Hex,
      args.agreementDigest as Hex,
      args.input.uploader as Hex,
      args.input.sequence,
      args.input.prevCommitment as Hex,
      filesHash,
      args.input.metadataCommitment as Hex,
    ]),
  );
}
