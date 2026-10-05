// Registries for delivery forms and message threads. Interface +
// implementation live here with NO Store dependency, so category/message routes
// stay usable without the persistence layer. Keyed by lowercase dealId.
//
// Durable mode (see configureRegistry): when an adapter is attached, writes are
// write-through to the registry_kv store and can be rehydrated after a restart.
// Without an adapter the behavior is exactly the original in-memory one.
import { DurableCollection, orderedKey, RegistryWriter, type RegistryAdapter } from "@midman/store";

const FORM_NS = "categories.delivery-form";
const MESSAGE_NS = "categories.messages";

export interface DeliveryFormRecord {
  readonly dealId: string;
  readonly category: string;
  readonly data: Record<string, unknown>;
  readonly deliveryManifestHash: string;
  readonly submittedBy: string;
  readonly submittedAt: string;
  readonly version: number;
}

export interface DeliveryFormRegistry {
  /**
   * Store a form as the single active form for the deal; keeps versioned
   * history. Resolves only once the durable write has committed, and allocates
   * the version from a durable counter so concurrent instances do not collide.
   */
  set(input: Omit<DeliveryFormRecord, "version">): Promise<DeliveryFormRecord>;
  get(dealId: string): DeliveryFormRecord | null;
  history(dealId: string): DeliveryFormRecord[];
  clear(): void;
}

export class InMemoryDeliveryFormRegistry implements DeliveryFormRegistry {
  private readonly writer = new RegistryWriter();
  private readonly forms = new DurableCollection<DeliveryFormRecord>(FORM_NS, this.writer, (record) =>
    orderedKey(record.version),
  );

  setAdapter(adapter: RegistryAdapter | null): void {
    this.writer.setAdapter(adapter);
  }

  flush(): Promise<void> {
    return this.writer.flush();
  }

  async hydrate(dealIds?: string[]): Promise<void> {
    await this.forms.hydrate(dealIds);
  }

  async set(input: Omit<DeliveryFormRecord, "version">): Promise<DeliveryFormRecord> {
    const key = input.dealId.toLowerCase();
    const version = await this.writer.nextSeq(`${FORM_NS}:${key}`);
    const record: DeliveryFormRecord = {
      ...input,
      data: { ...input.data },
      version,
    };
    // Await the durable write: a blocked/failed write must not return success.
    await this.forms.set(key, orderedKey(version), record);
    return { ...record, data: { ...record.data } };
  }

  get(dealId: string): DeliveryFormRecord | null {
    const list = this.forms.list(dealId.toLowerCase());
    const record = list[list.length - 1];
    return record ? { ...record, data: { ...record.data } } : null;
  }

  history(dealId: string): DeliveryFormRecord[] {
    return this.forms.list(dealId.toLowerCase()).map((record) => ({
      ...record,
      data: { ...record.data },
    }));
  }

  clear(): void {
    for (const dealId of this.forms.dealIds()) void this.forms.clearDeal(dealId);
  }
}

export interface ThreadMessage {
  readonly seq: number;
  readonly author: string;
  readonly text: string;
  readonly at: string;
}

export interface MessageThreadRegistry {
  /**
   * Append a message; sequence numbers are per-deal, starting at 1 and drawn
   * from a durable counter. Resolves only once the durable write has committed.
   */
  append(dealId: string, author: string, text: string): Promise<ThreadMessage>;
  list(dealId: string): ThreadMessage[];
  clear(): void;
}

export class InMemoryMessageThreadRegistry implements MessageThreadRegistry {
  private readonly writer = new RegistryWriter();
  private readonly threads = new DurableCollection<ThreadMessage>(MESSAGE_NS, this.writer, (record) =>
    orderedKey(record.seq),
  );

  setAdapter(adapter: RegistryAdapter | null): void {
    this.writer.setAdapter(adapter);
  }

  flush(): Promise<void> {
    return this.writer.flush();
  }

  async hydrate(dealIds?: string[]): Promise<void> {
    await this.threads.hydrate(dealIds);
  }

  async append(dealId: string, author: string, text: string): Promise<ThreadMessage> {
    const key = dealId.toLowerCase();
    const seq = await this.writer.nextSeq(`${MESSAGE_NS}:${key}`);
    const record: ThreadMessage = {
      seq,
      author,
      text,
      at: new Date().toISOString(),
    };
    // Await the durable write: a blocked/failed write must not return success.
    await this.threads.set(key, orderedKey(seq), record);
    return { ...record };
  }

  list(dealId: string): ThreadMessage[] {
    return this.threads.list(dealId.toLowerCase()).map((record) => ({ ...record }));
  }

  clear(): void {
    for (const dealId of this.threads.dealIds()) void this.threads.clearDeal(dealId);
  }
}

/** Shared singletons used when register fns are called without explicit registries. */
export const deliveryForms = new InMemoryDeliveryFormRegistry();
export const messageThreads = new InMemoryMessageThreadRegistry();

/**
 * Switch the shared category registries to durable mode and rehydrate. The lead
 * wires this in server.ts: `await configureRegistry(adapter)`.
 */
export async function configureRegistry(adapter: RegistryAdapter | null, dealIds?: string[]): Promise<void> {
  deliveryForms.setAdapter(adapter);
  messageThreads.setAdapter(adapter);
  await Promise.all([deliveryForms.hydrate(dealIds), messageThreads.hydrate(dealIds)]);
}

/** Sync test hook: attach an adapter without hydrating. */
export function __setRegistryForTests(adapter: RegistryAdapter | null): void {
  deliveryForms.setAdapter(adapter);
  messageThreads.setAdapter(adapter);
}

/** Await queued durable writes (tests only). */
export async function __flushCategoryRegistriesForTests(): Promise<void> {
  await Promise.all([deliveryForms.flush(), messageThreads.flush()]);
}

export function resetCategoryRegistries(): void {
  deliveryForms.clear();
  messageThreads.clear();
  deliveryForms.setAdapter(null);
  messageThreads.setAdapter(null);
}
