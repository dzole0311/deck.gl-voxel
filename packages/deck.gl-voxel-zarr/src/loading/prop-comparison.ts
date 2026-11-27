function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Compares option values, while keeping identity checks for Headers and other non-plain objects. */
export function equalOptions(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => equalOptions(value, right[index]))
    );
  }
  if (!isPlainRecord(left) || !isPlainRecord(right)) {
    return false;
  }
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && equalOptions(left[key], right[key]))
  );
}

/** Field sets compare by membership so a newly created equivalent set keeps the current reader. */
export function equalFieldSelection(
  left: ReadonlySet<string> | undefined,
  right: ReadonlySet<string> | undefined,
): boolean {
  return (
    left === right ||
    Boolean(left && right && left.size === right.size && [...left].every((path) => right.has(path)))
  );
}
