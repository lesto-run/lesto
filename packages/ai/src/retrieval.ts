/**
 * The retrieval seam — RAG through a Lesto-owned boundary (ADR 0021, Increment 3).
 *
 * Lesto owns the SEAM (`VectorStore`), not a vector database. The two real
 * backends — pgvector on the Postgres leg, Cloudflare Vectorize on the edge leg —
 * are the same "SQLite-local → Postgres-prod, same API" parity split `@lesto/db`
 * already lives, and are deferred behind the parity gate. The spike proves the
 * flow against an in-memory stub behind the interface, so RAG works with no DB.
 *
 * Embeddings reuse the existing `@lesto/content-embeddings` PREVIEW work; this
 * file takes an already-computed query vector and never embeds — keeping it pure
 * and dependency-free.
 */

/** A stored vector with the text it represents and arbitrary metadata. */
export interface VectorRecord {
  readonly id: string;
  readonly embedding: readonly number[];
  /** The chunk of source text this vector represents — what gets injected as context. */
  readonly text: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** A retrieval hit: the matched record plus its similarity score. */
export interface VectorMatch {
  readonly record: VectorRecord;
  /** Cosine similarity in [-1, 1]; higher is closer. */
  readonly score: number;
}

/** Options for a similarity query. */
export interface VectorQueryOptions {
  /** How many nearest records to return. */
  readonly topK: number;
}

/**
 * The vector-store boundary every backend implements (ADR 0006: depend on
 * interfaces, not drivers). pgvector and Vectorize are two implementations of
 * this; the spike ships {@link MemoryVectorStore} for tests and demos.
 */
export interface VectorStore {
  /** Insert or replace records by id. */
  upsert(records: readonly VectorRecord[]): Promise<void>;
  /** Return the `topK` records nearest to `embedding`, most similar first. */
  query(embedding: readonly number[], options: VectorQueryOptions): Promise<VectorMatch[]>;
}

/**
 * An in-memory, brute-force `VectorStore` — the spike's stand-in for pgvector /
 * Vectorize. It is intentionally O(n) cosine scan: correct, dependency-free, and
 * enough to prove the RAG flow and exercise the seam in tests. NOT for production
 * scale — a real backend does the nearest-neighbour search in the database.
 */
export class MemoryVectorStore implements VectorStore {
  readonly #records = new Map<string, VectorRecord>();

  async upsert(records: readonly VectorRecord[]): Promise<void> {
    for (const record of records) {
      this.#records.set(record.id, record);
    }
  }

  async query(embedding: readonly number[], options: VectorQueryOptions): Promise<VectorMatch[]> {
    const scored = [...this.#records.values()].map((record) => ({
      record,
      score: cosineSimilarity(embedding, record.embedding),
    }));

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, Math.max(0, options.topK));
  }
}

export interface RetrieveOptions {
  readonly store: VectorStore;
  /** The already-computed query embedding (from `@lesto/content-embeddings` or the caller). */
  readonly embedding: readonly number[];
  readonly topK: number;
}

/** A retrieved context: the matches and the assembled text block to prepend to a prompt. */
export interface RetrievedContext {
  readonly matches: readonly VectorMatch[];
  /** The matched chunks joined into one block, ready to inject into a system/user message. */
  readonly context: string;
}

/**
 * Retrieve the `topK` most relevant chunks for a query embedding and assemble
 * them into a context block — the "retrieve" half of retrieve-then-generate.
 *
 *   const { context } = await retrieve({ store, embedding, topK: 5 });
 *   const { text } = await generateText({ model, messages: withContext(context, messages) });
 *
 * Pure given the store; the embedding is the caller's, so this never touches a
 * model or a network.
 */
export async function retrieve(options: RetrieveOptions): Promise<RetrievedContext> {
  const matches = await options.store.query(options.embedding, { topK: options.topK });

  const context = matches.map((match) => match.record.text).join("\n\n");

  return { matches, context };
}

/**
 * Cosine similarity of two equal-length vectors.
 *
 * Mismatched lengths are a programming error (the index and the query came from
 * different embedders); we treat a zero-magnitude vector as maximally dissimilar
 * (score 0) rather than dividing by zero.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);

  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;

    dot += av * bv;
    magA += av * av;
    magB += bv * bv;
  }

  if (magA === 0 || magB === 0) {
    return 0;
  }

  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}
