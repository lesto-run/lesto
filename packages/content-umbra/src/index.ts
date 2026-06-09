import type { Parser, ParserOption, ParserPreset } from "./types";
import { jsonParser } from "./json";
import { yamlParser } from "./yaml";
import { frontmatterParser, frontmatterOnlyParser } from "./frontmatter";

export type { Parser, ParserOption, ParserPreset, ParseOutput } from "./types";
export { jsonParser } from "./json";
export { yamlParser } from "./yaml";
export {
  frontmatterParser,
  frontmatterOnlyParser,
  parseFrontmatter,
  parseFrontmatterCached,
  hasFrontmatter,
  detectLanguage,
  stringify,
  extractExcerpt,
  clearYamlCache,
  clearContentCache,
  type ParseOptions,
  type ParseResult,
  type FrontmatterLanguage,
} from "./frontmatter";
export { JsonParseError } from "./json";
export { YamlParseError } from "./yaml";
export { FrontmatterParseError } from "./frontmatter";

const parserRegistry: Record<ParserPreset, Parser> = {
  frontmatter: frontmatterParser,
  "frontmatter-only": frontmatterOnlyParser,
  json: jsonParser,
  yaml: yamlParser,
};

export function getParserExtensions(preset: ParserPreset): string[] {
  return parserRegistry[preset].extensions;
}

export function isValidPreset(name: string): name is ParserPreset {
  return name in parserRegistry;
}

export function resolveParser(option: ParserOption | undefined): Parser {
  if (option === undefined) {
    return frontmatterParser;
  }

  if (typeof option === "string") {
    const parser = parserRegistry[option];
    if (!parser) {
      throw new Error(
        `Unknown parser preset: "${option}". ` +
          `Valid presets are: ${Object.keys(parserRegistry).join(", ")}`,
      );
    }
    return parser;
  }

  if (typeof option === "function") {
    return {
      name: "custom",
      extensions: [],
      hasContent: true,
      parse: option,
    };
  }

  return option;
}

export function getDefaultIncludePatterns(parser: Parser): string[] {
  if (parser.extensions.length === 0) {
    return [];
  }

  if (parser.extensions.length === 1) {
    return [`**/*.${parser.extensions[0]}`];
  }

  return [`**/*.{${parser.extensions.join(",")}}`];
}

export function detectParserByExtension(extension: string): Parser | undefined {
  const ext = extension.toLowerCase();

  for (const parser of Object.values(parserRegistry)) {
    if (parser.extensions.includes(ext)) {
      return parser;
    }
  }

  return undefined;
}
