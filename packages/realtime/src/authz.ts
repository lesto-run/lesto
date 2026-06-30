/**
 * Subscription authorization (ADR 0040 step 3, the net-new seam `L-85655d2c`).
 *
 * Topic authz is **principal → tenant-scope** ("does this principal's org own
 * `org:123`?"), a *different* check from the role→permission `can()` guard. It is
 * the access decision for a live stream: an unauthorized topic is **dropped, not
 * fatal** — the connection still opens for whatever the principal may see — which
 * closes ADR 0027's change-*timing* side-channel (a viewer must not learn *when* an
 * operator-only record changes). The check itself is injected by the app, where the
 * principal and the tenancy model live; this module is the pure selection logic
 * over that seam, fully tested.
 */

/** The authorized and dropped partition of a connection's requested topics. */
export interface TopicSelection {
  /** Topics the principal may subscribe to — the connection's live set. */
  readonly authorized: string[];

  /**
   * Topics refused — over the per-connection cap, or denied by the authz check.
   * The handler logs these (not fatal); they are surfaced so the drop is visible.
   */
  readonly dropped: string[];
}

/**
 * Partition a connection's requested topics into the authorized set and the
 * dropped set, enforcing the per-connection cap first and the authz check second.
 *
 * The cap is applied **before** the authz check so a client cannot force unbounded
 * authz work by requesting thousands of topics: everything past `maxTopics` is
 * dropped without a check. Within the cap, `authorize` decides each — a `false`
 * (or a rejected promise is the caller's to guard; here a thrown check propagates)
 * drops the topic. Order is preserved so the result is deterministic.
 *
 * Generic over the principal type `P` so `@lesto/realtime` needs no `@lesto/authz`
 * dependency — the app supplies both the principal and the check.
 */
export async function selectAuthorizedTopics<P>(
  principal: P,
  requested: readonly string[],
  authorize: (principal: P, topic: string) => boolean | Promise<boolean>,
  maxTopics: number,
): Promise<TopicSelection> {
  const authorized: string[] = [];
  const dropped: string[] = [];

  for (const [index, topic] of requested.entries()) {
    // Past the per-connection cap: dropped without an authz check (no unbounded
    // work from a client that requests thousands of topics).
    if (index >= maxTopics) {
      dropped.push(topic);

      continue;
    }

    if (await authorize(principal, topic)) {
      authorized.push(topic);
    } else {
      dropped.push(topic);
    }
  }

  return { authorized, dropped };
}
