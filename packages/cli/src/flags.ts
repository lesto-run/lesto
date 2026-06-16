/**
 * A tiny flag parser — just enough for the CLI's needs.
 *
 * We deliberately keep this minimal rather than reaching for a dependency: the
 * CLI takes one numeric flag (`--port`). The parser scans the args after the
 * command and reads the value that follows the flag, falling back to a default
 * when the flag is absent or its value is not a number.
 */

export interface PortFlag {
  /** The parsed `--port` value, or the supplied default when none was given. */
  readonly port: number;
}

/**
 * Read `--port <n>` out of the command's args.
 *
 * The flag's value is the token immediately after `--port`. A missing flag, a
 * trailing `--port` with no value, or a non-numeric value all fall back to the
 * default — the CLI should never crash on a fat-fingered port.
 */
export function parsePort(args: readonly string[], fallback: number): PortFlag {
  const index = args.indexOf("--port");

  // No flag: the caller gets the default.
  if (index === -1) return { port: fallback };

  const raw = args[index + 1];

  // `--port` with nothing after it: nothing to parse.
  if (raw === undefined) return { port: fallback };

  const value = Number(raw);

  // A non-numeric value (NaN) is not a port; keep the default.
  if (Number.isNaN(value)) return { port: fallback };

  return { port: value };
}

/**
 * Read `--<name> <value>` out of the command's args.
 *
 * The flag's value is the token immediately after it. A missing flag — or a
 * trailing flag with no value — returns `undefined`, leaving the caller to apply
 * whatever default the command wants.
 */
export function parseStringFlag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);

  if (index === -1) return undefined;

  return args[index + 1];
}

/**
 * True iff a boolean flag (`--<name>`) is present, order-independent.
 *
 * A bare switch with no value: its presence is the signal. `keel mcp --operator`
 * opts into operator mode; absent leaves the safe read-only default.
 */
export function hasFlag(args: readonly string[], name: string): boolean {
  return args.includes(`--${name}`);
}
