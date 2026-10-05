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
export type AttributeValue =
  string | number | boolean | Date | readonly AttributeValue[] | AttributeRecord;

export interface AttributeRecord {
  readonly [key: string]: AttributeValue;
}

export type AttributeBag = Readonly<Record<string, AttributeValue | undefined>>;
export type AttributeBagName = "subject" | "resource" | "action" | "environment";
export type AttributeValueType = "string" | "number" | "boolean" | "date" | "array";
export type AttributeCategory = AttributeBagName;

export interface AttributeBags {
  readonly subject: AttributeBag;
  readonly resource: AttributeBag;
  readonly action: AttributeBag;
  readonly environment: AttributeBag;
}

const BAG_NAMES: readonly AttributeBagName[] = ["subject", "resource", "action", "environment"];

function cloneValue(value: AttributeValue): AttributeValue {
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) {
    return Object.freeze((value as readonly AttributeValue[]).map((item) => cloneValue(item)));
  }
  if (typeof value === "object") return cloneBag(value as AttributeRecord) as AttributeRecord;
  return value;
}

function cloneBag(bag: AttributeBag): AttributeBag {
  const copy: Record<string, AttributeValue> = {};
  for (const [key, value] of Object.entries(bag)) {
    if (value !== undefined) copy[key] = cloneValue(value);
  }
  return Object.freeze(copy);
}

function matchesType(value: AttributeValue, type: AttributeValueType): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "date":
      return value instanceof Date && !Number.isNaN(value.getTime());
    case "array":
      return Array.isArray(value);
  }
}

/**
 * Immutable, validated request attributes organized using the standard ABAC
 * subject/resource/action/environment vocabulary. Reads are safe for missing
 * paths and return undefined instead of turning ordinary absence into an
 * exception or a grant.
 */
export class AttributeContext {
  // Definite-assignment assertions: these are assigned in the constructor via
  // Object.defineProperty, so they are always set, but a loop over
  // BAG_NAMES is not something the compiler can follow.
  readonly subject!: AttributeBag;
  readonly resource!: AttributeBag;
  readonly action!: AttributeBag;
  readonly environment!: AttributeBag;

  constructor(bags: Partial<AttributeBags> = {}) {
    for (const name of BAG_NAMES) {
      const bag = Object.hasOwn(bags, name) ? bags[name] : {};
      if (bag === undefined) {
        Object.defineProperty(this, name, {
          value: Object.freeze({}),
          enumerable: true,
          writable: false,
          configurable: false,
        });
        continue;
      }
      if (bag === null || typeof bag !== "object" || Array.isArray(bag)) {
        throw new TypeError(`${name} attributes must be an object.`);
      }
      Object.defineProperty(this, name, {
        value: cloneBag(bag),
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    Object.freeze(this);
  }

  static create(bags: Partial<AttributeBags> = {}): AttributeContext {
    return new AttributeContext(bags);
  }

  get(bag: AttributeBagName, path: string): AttributeValue | undefined {
    if (!path) return undefined;
    let current: AttributeValue | undefined = this[bag] as AttributeRecord;
    for (const segment of path.split(".")) {
      if (!segment || current === null || typeof current !== "object" || current instanceof Date) {
        return undefined;
      }
      current = (current as AttributeRecord)[segment];
      if (current === undefined) return undefined;
    }
    return current;
  }

  getTyped<T extends AttributeValueType>(
    bag: AttributeBagName,
    path: string,
    type: T,
  ):
    | Extract<
        AttributeValue,
        T extends "string"
          ? string
          : T extends "number"
            ? number
            : T extends "boolean"
              ? boolean
              : T extends "date"
                ? Date
                : readonly AttributeValue[]
      >
    | undefined {
    const value = this.get(bag, path);
    return value !== undefined && matchesType(value, type) ? (value as never) : undefined;
  }

  getString(bag: AttributeBagName, path: string): string | undefined {
    return this.getTyped(bag, path, "string");
  }

  getNumber(bag: AttributeBagName, path: string): number | undefined {
    return this.getTyped(bag, path, "number");
  }

  getBoolean(bag: AttributeBagName, path: string): boolean | undefined {
    return this.getTyped(bag, path, "boolean");
  }

  getDate(bag: AttributeBagName, path: string): Date | undefined {
    return this.getTyped(bag, path, "date");
  }

  getArray(bag: AttributeBagName, path: string): readonly AttributeValue[] | undefined {
    return this.getTyped(bag, path, "array");
  }

  resolve(path: string): AttributeValue | undefined {
    const separatorIndex = path.indexOf(".");
    if (separatorIndex === -1) return undefined;

    const category = path.slice(0, separatorIndex);
    const key = path.slice(separatorIndex + 1);
    if (!BAG_NAMES.includes(category as AttributeBagName)) return undefined;
    return this[category as AttributeBagName][key];
  }

  toBags(): AttributeBags {
    return {
      subject: cloneBag(this.subject),
      resource: cloneBag(this.resource),
      action: cloneBag(this.action),
      environment: cloneBag(this.environment),
    };
  }
}
