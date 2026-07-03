/**
 * Errors carry codes, not just prose.
 *
 * Every failure in the MCP control plane surfaces a stable, machine-readable
 * `code`. Agents, logs, and tests branch on the code — never on a message
 * string, which is free to change for humans without breaking machines.
 */

import { LestoError } from "@lesto/errors";

export type McpErrorCode =
  | "MCP_UNKNOWN_TOOL"
  /** No resource carries the requested URI — a client typo or a stale resource list. */
  | "MCP_UNKNOWN_RESOURCE"
  | "MCP_GENERATE_UNAVAILABLE"
  /** The optional content peers aren't installed, so the content tools can't load. */
  | "MCP_CONTENT_PACKAGES_MISSING"
  | "MCP_CONTENT_STORE_UNAVAILABLE"
  /** A loopback dev MCP request carried a foreign Origin/Host or a missing/wrong session token. */
  | "MCP_DEV_ORIGIN_REJECTED"
  /** The loopback dev MCP server was stood up without a strong enough per-session token. */
  | "MCP_DEV_TOKEN_REQUIRED"
  | "MCP_OPERATOR_REQUIRED"
  /** A Resource Server was built without the non-empty `resource` its audience guard needs. */
  | "MCP_RESOURCE_REQUIRED"
  /**
   * The dispatch-level policy floor (ADR 0043 D3) refused a governed domain tool: the resolved
   * principal's roles are not granted the tool's `requires.permission`. The belt-and-suspenders
   * floor enforced on EVERY transport — the HTTP path refuses the same call pre-dispatch (403),
   * stdio (which has only this gate) gets the identical verdict. An unauthenticated dispatch has
   * empty roles → every governed domain tool denies.
   */
  | "MCP_FORBIDDEN"
  /**
   * A domain tool's input failed its Zod schema at the dispatch boundary (ADR 0005/0043 D1): a
   * coded refusal naming the tool, never a raw crash — the input crosses the same validated
   * boundary as an HTTP body.
   */
  | "MCP_INVALID_TOOL_INPUT"
  /**
   * A DESTRUCTIVE domain tool declared no `requires.permission` and did not set the loud,
   * greppable `ungoverned: true` opt-out (ADR 0043 D2.1) — it would ship a write with no policy
   * floor, inverting deny-by-default. Refused at registration. The `createAdmin` convention verbatim.
   */
  | "MCP_DOMAIN_TOOL_UNGOVERNED"
  /**
   * A domain tool's `name` collides with a framework tool's name (checked against the FULL
   * framework set regardless of `omitTools`) or with another domain tool's — refused at
   * registration (ADR 0043 D2.3), so the name stays a stable, unshadowable capability identifier.
   */
  | "MCP_DOMAIN_TOOL_NAME_CONFLICT"
  /**
   * A governed domain tool (one declaring a `requires` floor) was registered on a context with no
   * `policy` configured (ADR 0043 D2.4): nothing could adjudicate its permission, so a
   * governed-on-paper tool would ship scope-ceiling-only. Refused at registration, both entry points.
   */
  | "MCP_DOMAIN_TOOL_POLICY_REQUIRED"
  /**
   * A NON-destructive domain tool declared a `requires` floor without an explicit `requires.scope`
   * (ADR 0043 L-0c458a04): the "defaults to the write scope" rule is for destructive tools only —
   * defaulting a read to the write scope would wrongly demand write. An explicit scope is required.
   */
  | "MCP_DOMAIN_TOOL_SCOPE_REQUIRED"
  /**
   * A deployment `toolPermissions` entry named a DOMAIN tool (ADR 0043 D3): the declaration is the
   * single owner of a domain tool's floor, so the two maps cannot disagree about one tool's
   * permission. Refused at handler construction.
   */
  | "MCP_DOMAIN_TOOL_FLOOR_CONFLICT"
  /**
   * A deployment `toolPermissions` entry named no built tool (ADR 0043 L-0c458a04): a typo'd entry
   * would otherwise ship the INTENDED tool floorless. Refused at handler construction.
   */
  | "MCP_UNKNOWN_TOOL_FLOOR"
  /**
   * An `omitTools` entry named no known tool (ADR 0043 L-0c458a04): a typo'd omit (`handle_reqeust`)
   * would silently LEAVE the intended tool exposed — the fail-OPEN inverse of the reserved-name rule.
   * Refused, for symmetry: an omit names a framework tool (incl. the dev names) or a declared domain
   * tool, or it is a mistake. Checked against the reserved framework set, so omitting a dev tool on a
   * non-dev server (where it is not built) is fine.
   */
  | "MCP_UNKNOWN_OMIT_TOOL";

/** Anything the MCP control plane can refuse to do. */
export class McpError extends LestoError<McpErrorCode> {
  constructor(code: McpErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "McpError";
  }
}
