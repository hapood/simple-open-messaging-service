import {
  Controller,
  Post,
  Body,
  Request,
  UseGuards,
  UploadedFile,
  UseInterceptors,
  UsePipes,
  ParseFilePipe,
  FileTypeValidator,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { MessageService } from '../message/message.service';
import { ContentType } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { StandardResponse } from './utils';
import * as dayjs from 'dayjs';
import { diskStorage } from 'multer';
import { SendFileValidationPipe } from 'src/file/SendFileValiditionPipe';
import { CalcFileDestInterceptor } from 'src/file/CalcFileDestInterceptor';
@Controller()
export class GroupController {
  constructor(private readonly messageService: MessageService) {}

  @UseGuards(JwtAuthGuard)
  @Post('file/send-image')
  @UsePipes(new SendFileValidationPipe())
  @UseInterceptors(
    new CalcFileDestInterceptor(),
    FileInterceptor('file', {
      storage: diskStorage({
        destination: function (req, file, callback) {
          callback(null, './uploads/' + 'threadId');
        },
        filename: function (req, file, cb) {
          cb(null, file.fieldname + '-' + Date.now());
        },
      }),
    }),
  )
  sendImageFile(
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new FileTypeValidator({ fileType: /.(jpg|webp|png|jpeg)/ }),
        ],
      }),
    )
    file: Express.Multer.File,
  ) {
    console.log(file);
  }

  @UseGuards(JwtAuthGuard)
  @Post('file/send-video')
  @UsePipes(new SendFileValidationPipe())
  @UseInterceptors(
    new CalcFileDestInterceptor(),
    FileInterceptor('file', {
      storage: diskStorage({
        destination: function (req, file, callback) {
          callback(null, './uploads/' + 'threadId');
        },
        filename: function (req, file, cb) {
          cb(null, file.fieldname + '-' + Date.now());
        },
      }),
    }),
  )
  sendVideoFile(
    @UploadedFile(
      new ParseFilePipe({
        validators: [new FileTypeValidator({ fileType: /.(mp4|webm|ogg)/ })],
      }),
    )
    file: Express.Multer.File,
  ) {
    console.log(file);
  }

  @UseGuards(JwtAuthGuard)
  @Post('file/send-video')
  @UsePipes(new SendFileValidationPipe())
  @UseInterceptors(
    new CalcFileDestInterceptor(),
    FileInterceptor('file', {
      storage: diskStorage({
        destination: function (req, file, callback) {
          callback(null, './uploads/' + 'threadId');
        },
        filename: function (req, file, cb) {
          cb(null, file.fieldname + '-' + Date.now());
        },
      }),
    }),
  )
  sendAudioFile(
    @UploadedFile(
      new ParseFilePipe({
        validators: [new FileTypeValidator({ fileType: /.(mp3|wav|acc)/ })],
      }),
    )
    file: Express.Multer.File,
  ) {
    console.log(file);
  }

  @UseGuards(JwtAuthGuard)
  @Post('file/send-general-file')
  @UsePipes(new SendFileValidationPipe())
  @UseInterceptors(
    new CalcFileDestInterceptor(),
    FileInterceptor('file', {
      storage: diskStorage({
        destination: function (req, file, callback) {
          callback(null, './uploads/' + 'threadId');
        },
        filename: function (req, file, cb) {
          cb(null, file.fieldname + '-' + Date.now());
        },
      }),
    }),
  )
  sendGeneralFile(
    @UploadedFile(new ParseFilePipe()) file: Express.Multer.File,
  ) {
    console.log(file);
  }
}
