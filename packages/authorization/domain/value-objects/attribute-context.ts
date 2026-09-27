/**
 * The facts a policy condition is evaluated against: subject, resource,
 * action and environment attributes, keyed by dot-separated path
 * (`"subject.role"`, `"resource.ownerId"`, `"environment.ipAllowlisted"`).
 *
 * A flat, string-keyed bag rather than a `{ subject, resource, action,
 * environment }` object was the alternative here. The flat shape wins because
 * {@link readAttribute} and the linter's constraint extraction both need to
 * address an attribute by a single opaque key without knowing which category
 * it lives in in advance — a policy author can name any attribute path they
 * like, and the evaluator has no reason to special-case the four XACML
 * categories in code.
 *
 * Values are `unknown` rather than a specific primitive union, because
 * attribute providers (Issue 154 — not yet built) will supply whatever the
 * resource domain owns: strings, numbers, booleans, arrays for `in`/`notIn`
 * checks. The evaluator narrows at the point of comparison, never before.
 */
export type AttributeContext = Readonly<Record<string, unknown>>;

/**
 * Reads an attribute by its dot-separated path, returning `undefined` for any
 * missing segment rather than throwing.
 *
 * Attribute paths are looked up as literal keys first (`context["subject.role"]`)
 * before falling back to nested traversal (`context.subject.role`), so a
 * context built as a flat map (the common case — see {@link AttributeContext})
 * and one built as nested objects (convenient for hand-written test fixtures)
 * both work without the caller having to know which shape is in play.
 */
export function readAttribute(context: AttributeContext, path: string): unknown {
  if (Object.prototype.hasOwnProperty.call(context, path)) {
    // Dynamic-key lookup is this function's entire purpose — an attribute
    // path is only known at policy-authoring time, not at compile time — so
    // this can't be restructured away the way the same lint warning was
    // avoided elsewhere in the codebase. The `hasOwnProperty` check just
    // above is the actual mitigation: it rules out inherited/prototype
    // properties (e.g. `"toString"`, `"__proto__"`) before this line ever
    // runs, which is what the rule exists to guard against.
    // eslint-disable-next-line security/detect-object-injection
    return context[path];
  }

  const segments = path.split(".");
  let current: unknown = context;

  for (const segment of segments) {
    if (
      current === null ||
      current === undefined ||
      typeof current !== "object" ||
      !Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      return undefined;
    }
    // Guarded by the `hasOwnProperty` check above, for the same reason as
    // the literal-key lookup earlier in this function.
    // eslint-disable-next-line security/detect-object-injection
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}
