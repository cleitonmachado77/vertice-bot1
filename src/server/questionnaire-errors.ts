export class QuestionnaireTemporarilyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuestionnaireTemporarilyUnavailableError';
  }
}
