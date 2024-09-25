
import {
  Injectable,
  PipeTransform,
  ArgumentMetadata,
} from '@nestjs/common'

@Injectable()
export class SendFileValidationPipe implements PipeTransform {
  async transform(value: any, metadata: ArgumentMetadata) {
    // if (!metatype || !this.toValidate(metatype)) {
    //   return value;
    // }
    // const object = plainToInstance(metatype, value);
    // const errors = await validate(object);
    // if (errors.length > 0) {
    //   throw new BadRequestException('Validation failed');
    // }
    return value;
  }

  private toValidate(metatype: Function): boolean {
    const types: Function[] = [String, Boolean, Number, Array, Object];
    return !types.includes(metatype);
  }
}