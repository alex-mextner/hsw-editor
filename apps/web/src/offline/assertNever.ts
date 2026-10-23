/** Compile-time exhaustiveness: a new union member makes the `switch` that ends in this call fail to type-check. */
export function assertNever(value: never): never {
  throw new Error(`unhandled case: ${JSON.stringify(value)}`);
}
