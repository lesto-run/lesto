import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  RULE_NAMES,
  DEFAULT_SEVERITIES,
  normalizeSeverity,
  resolveConfig,
  type LumenConfig,
  type RuleName,
} from './config.js';

describe('RULE_NAMES', () => {
  it('contains all expected rules', () => {
    expect(RULE_NAMES).toContain('fillers');
    expect(RULE_NAMES).toContain('weasel');
    expect(RULE_NAMES).toContain('hedge');
    expect(RULE_NAMES).toContain('condescending');
    expect(RULE_NAMES).toContain('repeated');
    expect(RULE_NAMES).toContain('simplify');
    expect(RULE_NAMES).toContain('profanity');
    expect(RULE_NAMES).toContain('passive');
    expect(RULE_NAMES).toContain('adverbs');
    expect(RULE_NAMES).toContain('cliches');
    expect(RULE_NAMES).toContain('readability');
  });

  it('has 12 rules', () => {
    expect(RULE_NAMES).toHaveLength(12);
  });
});

describe('DEFAULT_SEVERITIES', () => {
  it('has defaults for all rules', () => {
    for (const ruleName of RULE_NAMES) {
      expect(DEFAULT_SEVERITIES[ruleName]).toBeDefined();
    }
  });

  it('sets repeated and profanity as error', () => {
    expect(DEFAULT_SEVERITIES.repeated).toBe('error');
    expect(DEFAULT_SEVERITIES.profanity).toBe('error');
  });

  it('sets other rules as warn', () => {
    const warnRules: RuleName[] = ['fillers', 'weasel', 'hedge', 'condescending', 'simplify', 'passive', 'adverbs', 'cliches'];
    for (const rule of warnRules) {
      expect(DEFAULT_SEVERITIES[rule]).toBe('warn');
    }
  });
});

describe('normalizeSeverity', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('returns default when value is undefined', () => {
    expect(normalizeSeverity(undefined, 'warn')).toBe('warn');
    expect(normalizeSeverity(undefined, 'error')).toBe('error');
  });

  it('normalizes "off" to "off"', () => {
    expect(normalizeSeverity('off', 'warn')).toBe('off');
  });

  it('normalizes 0 to "off"', () => {
    expect(normalizeSeverity(0, 'warn')).toBe('off');
  });

  it('normalizes "warn" to "warn"', () => {
    expect(normalizeSeverity('warn', 'error')).toBe('warn');
  });

  it('normalizes 1 to "warn"', () => {
    expect(normalizeSeverity(1, 'error')).toBe('warn');
  });

  it('normalizes "error" to "error"', () => {
    expect(normalizeSeverity('error', 'warn')).toBe('error');
  });

  it('normalizes 2 to "error"', () => {
    expect(normalizeSeverity(2, 'warn')).toBe('error');
  });

  it('warns and uses default for invalid values', () => {
    // @ts-expect-error - testing invalid value
    const result = normalizeSeverity('invalid', 'warn');
    expect(result).toBe('warn');
    expect(consoleSpy).toHaveBeenCalledWith('Invalid severity "invalid", using default "warn"');
  });
});

describe('resolveConfig', () => {
  it('returns all defaults when config is null', () => {
    const resolved = resolveConfig(null);
    expect(resolved.rules).toEqual(DEFAULT_SEVERITIES);
  });

  it('returns all defaults when config has empty rules', () => {
    const resolved = resolveConfig({ rules: {} });
    expect(resolved.rules).toEqual(DEFAULT_SEVERITIES);
  });

  it('merges partial config with defaults', () => {
    const config: LumenConfig = {
      rules: {
        fillers: 'off',
        weasel: 'error',
      },
    };
    const resolved = resolveConfig(config);

    expect(resolved.rules.fillers).toBe('off');
    expect(resolved.rules.weasel).toBe('error');
    // Other rules should use defaults
    expect(resolved.rules.hedge).toBe('warn');
    expect(resolved.rules.repeated).toBe('error');
  });

  it('normalizes numeric values', () => {
    const config: LumenConfig = {
      rules: {
        fillers: 0,
        weasel: 1,
        hedge: 2,
      },
    };
    const resolved = resolveConfig(config);

    expect(resolved.rules.fillers).toBe('off');
    expect(resolved.rules.weasel).toBe('warn');
    expect(resolved.rules.hedge).toBe('error');
  });

  it('overrides default severity correctly', () => {
    const config: LumenConfig = {
      rules: {
        repeated: 'warn', // Default is error
        fillers: 'error', // Default is warn
      },
    };
    const resolved = resolveConfig(config);

    expect(resolved.rules.repeated).toBe('warn');
    expect(resolved.rules.fillers).toBe('error');
  });

  it('has all rules defined in resolved config', () => {
    const resolved = resolveConfig({ rules: { fillers: 'off' } });
    for (const ruleName of RULE_NAMES) {
      expect(resolved.rules[ruleName]).toBeDefined();
      expect(['off', 'warn', 'error']).toContain(resolved.rules[ruleName]);
    }
  });
});
