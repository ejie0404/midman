// Shared helpers for evidence/category/message UI: wallet-backed
// signed-request auth plus clipboard copy with a legacy fallback.

import type { RequestSigner } from "../../lib/requestAuth";
import { getAccount, getWalletClient } from "../../lib/wallet";

/** Build a RequestSigner from the connected browser wallet (personal_sign). */
export async function connectEvidenceAuth(): Promise<RequestSigner> {
  const account = await getAccount();
  const client = getWalletClient();
  return {
    address: account,
    signMessage: (message: string) => client.signMessage({ account, message }) as Promise<string>,
  };
}

/** Copy text to the clipboard; falls back to a hidden textarea. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const done = document.execCommand("copy");
      area.remove();
      return done;
    } catch {
      return false;
    }
  }
}
