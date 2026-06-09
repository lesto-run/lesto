/**
 * AI configuration resolution and validation.
 */

import type { AIConfig, AIProvider, ResolvedAIConfig } from "./types";

/**
 * Default model per provider.
 */
const DEFAULT_MODELS: Record<AIProvider, string> = {
  anthropic: "claude-sonnet-4-20250514",
  openai: "gpt-4o",
};

/**
 * Environment variable names per provider.
 */
const ENV_VAR_NAMES: Record<AIProvider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

/**
 * Get API key from environment variable.
 */
function getEnvApiKey(provider: AIProvider): string | null {
  const envVar = ENV_VAR_NAMES[provider];
  return process.env[envVar] ?? null;
}

/**
 * Resolve AI configuration with defaults and environment variable fallbacks.
 *
 * Priority for API key:
 * 1. Explicit config.apiKey
 * 2. Environment variable (ANTHROPIC_API_KEY or OPENAI_API_KEY)
 */
export function resolveAIConfig(config: AIConfig | undefined): ResolvedAIConfig {
  const provider = config?.provider ?? "anthropic";
  const enabled = config?.enabled ?? true;

  // Get API key from config or environment
  const apiKey = config?.apiKey ?? getEnvApiKey(provider);

  return {
    provider,
    apiKey,
    model: config?.model ?? DEFAULT_MODELS[provider],
    maxTokens: config?.maxTokens ?? 4096,
    temperature: config?.temperature ?? 0.7,
    enabled,
  };
}

/**
 * Check if AI is properly configured and ready to use.
 * Returns true if enabled and has a valid API key.
 */
export function isAIConfigured(resolved: ResolvedAIConfig): boolean {
  return resolved.enabled && resolved.apiKey !== null;
}

/**
 * Validate AI configuration and return any errors.
 * Returns empty array if valid.
 */
export function validateAIConfig(config: AIConfig | undefined): string[] {
  const errors: string[] = [];

  if (config?.provider && !["anthropic", "openai"].includes(config.provider)) {
    errors.push(`Invalid AI provider "${config.provider}". Must be "anthropic" or "openai".`);
  }

  if (config?.temperature !== undefined) {
    if (config.temperature < 0 || config.temperature > 1) {
      errors.push(`Invalid temperature ${config.temperature}. Must be between 0 and 1.`);
    }
  }

  if (config?.maxTokens !== undefined) {
    if (config.maxTokens < 1 || config.maxTokens > 200000) {
      errors.push(`Invalid maxTokens ${config.maxTokens}. Must be between 1 and 200000.`);
    }
  }

  return errors;
}

/**
 * Get a human-readable status message for AI configuration.
 */
export function getAIConfigStatus(resolved: ResolvedAIConfig): string {
  if (!resolved.enabled) {
    return "AI features disabled";
  }

  if (!resolved.apiKey) {
    const envVar = ENV_VAR_NAMES[resolved.provider];
    return `AI not configured: missing API key. Set ${envVar} or configure ai.apiKey in docks.config.ts`;
  }

  return `AI configured: ${resolved.provider} (${resolved.model})`;
}
