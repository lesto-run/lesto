import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  resolveAIConfig,
  isAIConfigured,
  validateAIConfig,
  getAIConfigStatus,
} from "../ai-config";
import type { AIConfig } from "../types";

/** Coerce an arbitrary object into {@link AIConfig} to exercise runtime validation. */
function asAIConfig(value: object): AIConfig {
  return value as AIConfig;
}

describe("AI Config", () => {
  // Store original env values
  let originalAnthropicKey: string | undefined;
  let originalOpenAIKey: string | undefined;

  beforeEach(() => {
    originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
    originalOpenAIKey = process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    if (originalAnthropicKey) {
      process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
    }
    if (originalOpenAIKey) {
      process.env.OPENAI_API_KEY = originalOpenAIKey;
    }
  });

  describe("resolveAIConfig", () => {
    it("returns defaults when no config provided", () => {
      const resolved = resolveAIConfig(undefined);
      expect(resolved.provider).toBe("anthropic");
      expect(resolved.model).toBe("claude-sonnet-4-20250514");
      expect(resolved.maxTokens).toBe(4096);
      expect(resolved.temperature).toBe(0.7);
      expect(resolved.enabled).toBe(true);
      expect(resolved.apiKey).toBeNull();
    });

    it("uses provided config values", () => {
      const resolved = resolveAIConfig({
        provider: "openai",
        apiKey: "test-key",
        model: "gpt-4-turbo",
        maxTokens: 2048,
        temperature: 0.5,
        enabled: false,
      });
      expect(resolved.provider).toBe("openai");
      expect(resolved.apiKey).toBe("test-key");
      expect(resolved.model).toBe("gpt-4-turbo");
      expect(resolved.maxTokens).toBe(2048);
      expect(resolved.temperature).toBe(0.5);
      expect(resolved.enabled).toBe(false);
    });

    it("falls back to environment variable for Anthropic", () => {
      process.env.ANTHROPIC_API_KEY = "env-anthropic-key";
      const resolved = resolveAIConfig({ provider: "anthropic" });
      expect(resolved.apiKey).toBe("env-anthropic-key");
    });

    it("falls back to environment variable for OpenAI", () => {
      process.env.OPENAI_API_KEY = "env-openai-key";
      const resolved = resolveAIConfig({ provider: "openai" });
      expect(resolved.apiKey).toBe("env-openai-key");
    });

    it("explicit apiKey overrides environment variable", () => {
      process.env.ANTHROPIC_API_KEY = "env-key";
      const resolved = resolveAIConfig({
        provider: "anthropic",
        apiKey: "explicit-key",
      });
      expect(resolved.apiKey).toBe("explicit-key");
    });

    it("uses provider-specific default model", () => {
      expect(resolveAIConfig({ provider: "anthropic" }).model).toBe("claude-sonnet-4-20250514");
      expect(resolveAIConfig({ provider: "openai" }).model).toBe("gpt-4o");
    });
  });

  describe("isAIConfigured", () => {
    it("returns false when disabled", () => {
      const resolved = resolveAIConfig({ enabled: false, apiKey: "key" });
      expect(isAIConfigured(resolved)).toBe(false);
    });

    it("returns false when no API key", () => {
      const resolved = resolveAIConfig({ enabled: true });
      expect(isAIConfigured(resolved)).toBe(false);
    });

    it("returns true when enabled with API key", () => {
      const resolved = resolveAIConfig({ enabled: true, apiKey: "key" });
      expect(isAIConfigured(resolved)).toBe(true);
    });
  });

  describe("validateAIConfig", () => {
    it("returns empty array for valid config", () => {
      expect(validateAIConfig(undefined)).toEqual([]);
      expect(validateAIConfig({ provider: "anthropic" })).toEqual([]);
      expect(validateAIConfig({ temperature: 0.5 })).toEqual([]);
      expect(validateAIConfig({ maxTokens: 1000 })).toEqual([]);
    });

    it("validates provider", () => {
      const errors = validateAIConfig(asAIConfig({ provider: "invalid" }));
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("Invalid AI provider");
    });

    it("validates temperature range", () => {
      expect(validateAIConfig({ temperature: -0.1 })).toHaveLength(1);
      expect(validateAIConfig({ temperature: 1.1 })).toHaveLength(1);
      expect(validateAIConfig({ temperature: 0 })).toHaveLength(0);
      expect(validateAIConfig({ temperature: 1 })).toHaveLength(0);
    });

    it("validates maxTokens range", () => {
      expect(validateAIConfig({ maxTokens: 0 })).toHaveLength(1);
      expect(validateAIConfig({ maxTokens: 200001 })).toHaveLength(1);
      expect(validateAIConfig({ maxTokens: 1 })).toHaveLength(0);
      expect(validateAIConfig({ maxTokens: 200000 })).toHaveLength(0);
    });
  });

  describe("getAIConfigStatus", () => {
    it("returns disabled message when disabled", () => {
      const resolved = resolveAIConfig({ enabled: false });
      expect(getAIConfigStatus(resolved)).toBe("AI features disabled");
    });

    it("returns missing key message when no API key", () => {
      const resolved = resolveAIConfig({ provider: "anthropic" });
      expect(getAIConfigStatus(resolved)).toContain("missing API key");
      expect(getAIConfigStatus(resolved)).toContain("ANTHROPIC_API_KEY");
    });

    it("returns configured message when ready", () => {
      const resolved = resolveAIConfig({ provider: "anthropic", apiKey: "key" });
      expect(getAIConfigStatus(resolved)).toContain("AI configured");
      expect(getAIConfigStatus(resolved)).toContain("anthropic");
    });
  });
});
