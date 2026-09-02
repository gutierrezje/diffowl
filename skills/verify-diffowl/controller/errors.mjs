export class ControllerError extends Error {
  constructor({ command, expected, observed, likelyCause, nextAction, exitCode = 1 }) {
    super(likelyCause);
    this.name = "ControllerError";
    this.command = command;
    this.exitCode = exitCode;
    this.details = { expected, observed, likelyCause, nextAction };
  }
}
