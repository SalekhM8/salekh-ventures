/**
 * An error the control layer raises on purpose, with a fixed code a caller
 * can branch on. Anything else that is thrown is a bug or an outage.
 */
export class ControlError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "ControlError";
    this.code = code;
  }
}
