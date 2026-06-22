import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
@Injectable()
export class CalcFileDestInterceptor implements NestInterceptor {
  public intercept(_context: ExecutionContext, next: CallHandler) {
    // changing request
    const request = _context.switchToHttp().getRequest();
    if (request.body.name) {
      request.body.name = 'modify request';
    }

    return next.handle();
  }
}
