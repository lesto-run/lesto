export interface ParseOutput<TData = Record<string, unknown>> {
  data: TData;
  content: string;
}

export interface Parser<TData = Record<string, unknown>> {
  name: string;
  extensions: string[];
  hasContent: boolean;
  parse(content: string, filePath: string): ParseOutput<TData>;
}

export type ParserPreset = "frontmatter" | "frontmatter-only" | "json" | "yaml";

export type ParserOption<TData = Record<string, unknown>> =
  | ParserPreset
  | Parser<TData>
  | ((content: string, filePath: string) => ParseOutput<TData>);

export interface ParserSpec {
  parser: Parser;
  defaultExtensions: string[];
}
