export class StorageError extends Error {
  constructor(
    message: string,
    public readonly code: 'INVALID_OPERATION' | 'ALREADY_EXISTS' = 'INVALID_OPERATION',
  ) {
    super(message);
  }
}
