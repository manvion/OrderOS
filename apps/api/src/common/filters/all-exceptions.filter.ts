import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';

/**
 * Turns everything into a consistent error envelope and — critically — makes
 * sure an unexpected exception never leaks a stack trace, a SQL fragment or a
 * table name to the client. Prisma's own errors are mapped to sensible HTTP
 * codes rather than surfaced raw.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: Record<string, unknown> = {
      statusCode: status,
      error: 'InternalServerError',
      message: 'Something went wrong',
    };

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const response = exception.getResponse();
      body =
        typeof response === 'string'
          ? { statusCode: status, error: exception.name, message: response }
          : { statusCode: status, ...(response as Record<string, unknown>) };
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      switch (exception.code) {
        case 'P2002': {
          status = HttpStatus.CONFLICT;
          const target = (exception.meta?.target as string[] | undefined)?.join(', ');
          body = {
            statusCode: status,
            error: 'Conflict',
            message: target ? `A record with that ${target} already exists` : 'Already exists',
          };
          break;
        }
        case 'P2025':
          status = HttpStatus.NOT_FOUND;
          body = { statusCode: status, error: 'NotFound', message: 'Record not found' };
          break;
        case 'P2003':
          status = HttpStatus.BAD_REQUEST;
          body = {
            statusCode: status,
            error: 'BadRequest',
            message: 'Referenced record does not exist',
          };
          break;
        default:
          this.logger.error(`Unhandled Prisma error ${exception.code}`, exception.stack);
      }
    }

    if (status >= 500) {
      this.logger.error(
        `${req.method} ${req.url} -> ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    res.status(status).json({ ...body, path: req.url, timestamp: new Date().toISOString() });
  }
}
