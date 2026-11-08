export class TemplateError extends Error {
  constructor(
    message: string,
    public status = 400,
    public readonly publicMessage = message,
  ) {
    super(message);
  }
}
