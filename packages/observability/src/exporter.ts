import type { SpanData, SpanExporter } from "./types";

/**
 * The canonical test double: an exporter that simply keeps every span it is
 * handed, in the order they ended. Assert against `spans` after the fact.
 */
export class InMemoryExporter implements SpanExporter {
  readonly spans: SpanData[] = [];

  export(span: SpanData): void {
    this.spans.push(span);
  }
}
