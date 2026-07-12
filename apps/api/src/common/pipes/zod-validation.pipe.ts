import { BadRequestException, PipeTransform } from '@nestjs/common';
import { ZodSchema, ZodError } from 'zod';

/**
 * Validates a request body against a Zod schema from @orderos/shared — the same
 * schema the web form used, so the API and the UI agree on what "valid" means.
 *
 * On failure it returns a field-keyed error map that react-hook-form can render
 * directly against the offending inputs.
 */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown): T {
    try {
      return this.schema.parse(value);
    } catch (err) {
      if (err instanceof ZodError) {
        const fieldErrors: Record<string, string> = {};
        for (const issue of err.issues) {
          const path = issue.path.join('.') || '_root';
          if (!fieldErrors[path]) fieldErrors[path] = issue.message;
        }
        throw new BadRequestException({
          statusCode: 400,
          error: 'ValidationError',
          message: 'The submitted data is invalid',
          fieldErrors,
        });
      }
      throw err;
    }
  }
}
