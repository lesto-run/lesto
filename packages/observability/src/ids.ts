import { randomBytes } from "node:crypto";

/**
 * Identity, made injectable.
 *
 * The default generator draws 16 random bytes and renders them as hex — wide
 * enough to make collisions a non-event. Tests inject a counting generator
 * instead, so trace and span ids are predictable.
 */

export const randomHexId = (): string => randomBytes(16).toString("hex");
