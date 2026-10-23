/** A request the user can fix (unknown class, preset, impossible edit): the API answers 400, not 500. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}
