"use client";

import { useEffect, useState } from "react";
import {
  getConfirmation,
  getDealStatus,
  getDraftTerms,
  getQuote,
  ApiError,
  type Confirmation,
  type DealStatus,
  type DraftTerms,
  type QuoteResult,
} from "../../lib/api";

export interface DealView {
  loading: boolean;
  draftId: string | null;
  dealId: string | null;
  terms: DraftTerms | null;
  signatures: Record<string, string>;
  draftStatus: string | null;
  dealStatus: DealStatus | null;
  quote: QuoteResult | null;
  confirmation: Confirmation | null;
  confirmationError: string | null;
  error: string | null;
}

/** Resolve a dashboard id (draft_… or dealId 0x…) into draft terms + chain-first status. */
export function useDeal(id: string): DealView {
  const [view, setView] = useState<DealView>({
    loading: true,
    draftId: null,
    dealId: null,
    terms: null,
    signatures: {},
    draftStatus: null,
    dealStatus: null,
    quote: null,
    confirmation: null,
    confirmationError: null,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      let draftId: string | null = id.startsWith("draft_") ? id : null;
      let terms: DraftTerms | null = null;
      let signatures: Record<string, string> = {};
      let draftStatus: string | null = null;
      let dealId: string | null = id.startsWith("0x") ? id : null;
      let dealStatus: DealStatus | null = null;
      let quote: QuoteResult | null = null;
      let confirmation: Confirmation | null = null;
      let confirmationError: string | null = null;
      let error: string | null = null;

      if (draftId) {
        try {
          const t = await getDraftTerms(draftId);
          terms = t.terms;
          signatures = t.signatures;
          draftStatus = t.status;
          dealId = t.terms.dealId;
        } catch (e) {
          error = e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e);
        }
      }
      if (dealId && !cancelled) {
        try {
          dealStatus = await getDealStatus(dealId);
          if (!terms && dealStatus.terms) terms = dealStatus.terms;
          if (!draftStatus && dealStatus.status) draftStatus = dealStatus.status;
        } catch (e) {
          if (!terms) error = e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e);
        }
        try {
          confirmation = await getConfirmation(dealId);
        } catch (e) {
          confirmationError = e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e);
        }
      }
      if (draftId && terms && !cancelled) {
        try {
          quote = await getQuote(draftId);
        } catch {
          quote = null;
        }
      }
      if (!cancelled) {
        setView({
          loading: false,
          draftId,
          dealId,
          terms,
          signatures,
          draftStatus,
          dealStatus,
          quote,
          confirmation,
          confirmationError,
          error,
        });
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [id]);

  return view;
}
