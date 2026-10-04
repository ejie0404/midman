// Strong secret scanner for delivery forms, chat messages and evidence metadata.
// Pure function, no dependencies. Statically imported by the evidence upload
// validator (parallel worker), so the export signature below is frozen:
//
//   export function scanTextForSecrets(text: string): string[]
//
// Finding codes (stable, machine-readable):
//   PEM_BLOCK            — ASCII-armored PEM block (-----BEGIN ...-----)
//   SEED_PHRASE          — run of 12+ consecutive [a-z]{3,8} words (BIP-39 shape)
//   PRIVATE_KEY_ASSIGN   — (private key|secret|mnemonic|seed) followed by an
//                          assignment/delimiter char (space, ':' or '=')
//   HEX_SECRET           — 64 hex chars within ~80 chars of a secret-context word
//                          (bare hashes WITHOUT nearby context words pass, so
//                          fileHash / prevCommitment / nonce fields are safe)
//   CLOUD_KEY            — AWS key ids (AKIA/ASIA) + generic cloud token patterns
//                          (GitHub ghp_/gho_/github_pat_, Slack xox*, Google AIza,
//                          Stripe-like sk-live-/sk-test-, aws_secret_access_key)
//
// Callers must name the offending FIELD and the codes, and must NEVER echo the
// matched secret material back in an error or log line.

const PEM_RE = /-----BEGIN [^-]{1,64}-----/;

const ASSIGN_RE = /\b(private[_-]?key|secret|mnemonic|seed)\b[\s:=]+/i;

// 64 hex chars bounded on both sides (avoids matching a slice of longer blobs).
const HEX64_RE = /(^|[^0-9a-fA-F])(?:0x)?([0-9a-fA-F]{64})(?![0-9a-fA-F])/g;

// Words that make a nearby 64-hex blob look like a key, not a content hash.
const SECRET_CONTEXT_RE =
  /(private|secret|mnemonic|seed|password|passwd|pwd|recovery|credential|api[_-]?key|auth[_-]?token|bearer|wallet)/i;

const CLOUD_PATTERNS: RegExp[] = [
  /A[KS]IA[0-9A-Z]{16}/, // AWS access key id (AKIA/ASIA)
  /gh[pousr]_[A-Za-z0-9_]{20,}/, // GitHub token (ghp_/gho_/ghu_/ghs_/ghr_/github_pat_)
  /github_pat_[A-Za-z0-9_]{20,}/,
  /xox[bpas]-[A-Za-z0-9-]{8,}/, // Slack token
  /AIza[0-9A-Za-z_-]{35}/, // Google API key
  /sk-(live|test)-[A-Za-z0-9]{16,}/, // Stripe-like secret key
  /aws_secret_access_key\s*[:=]/i,
  /aws_session_token\s*[:=]/i,
];

function hasSeedPhrase(text: string): boolean {
  // Maximal runs of space/punctuation-separated lowercase 3-8 letter words.
  // Any other token (uppercase, digits, long words, numbers) breaks the run.
  const tokens = text.split(/[^A-Za-z]+/);
  let run = 0;
  for (const token of tokens) {
    if (/^[a-z]{3,8}$/.test(token)) {
      run += 1;
      if (run >= 12) return true;
    } else {
      run = 0;
    }
  }
  return false;
}

function hasHexSecret(text: string): boolean {
  HEX64_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HEX64_RE.exec(text)) !== null) {
    const hexStart = match.index + match[1]!.length;
    const window = text.slice(Math.max(0, hexStart - 80), hexStart + 80 + 64);
    // Test the window with the blob itself removed, so hex-letter sequences
    // inside the blob cannot self-trigger the context-word check.
    const withoutBlob = window.replace(/[0-9a-fA-F]{64}/, " ");
    if (SECRET_CONTEXT_RE.test(withoutBlob)) return true;
  }
  return false;
}

function hasCloudKey(text: string): boolean {
  return CLOUD_PATTERNS.some((re) => {
    re.lastIndex = 0;
    return re.test(text);
  });
}

export function scanTextForSecrets(text: string): string[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const findings: string[] = [];
  if (PEM_RE.test(text)) findings.push("PEM_BLOCK");
  if (hasSeedPhrase(text)) findings.push("SEED_PHRASE");
  ASSIGN_RE.lastIndex = 0;
  if (ASSIGN_RE.test(text)) findings.push("PRIVATE_KEY_ASSIGN");
  if (hasHexSecret(text)) findings.push("HEX_SECRET");
  if (hasCloudKey(text)) findings.push("CLOUD_KEY");
  return findings;
}
