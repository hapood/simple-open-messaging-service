import { Injectable } from '@nestjs/common';
import { existsSync, mkdirSync, writeFile, unlink } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { promisify } from 'util';
import sharp from 'sharp';
import type { FastifyRequest } from 'fastify';
import type { MultipartFile } from '@fastify/multipart';

const writeFileAsync = promisify(writeFile);
const unlinkAsync = promisify(unlink);

/** 允许的图片 mimetype → 扩展名（白名单 + 落盘扩展名映射）。 */
const IMG_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/**
 * consumeImage 的返回：成功带 buffer/宽高；失败按原因区分（控制器据 reason 映射业务码）。
 * 体积上限由 main.ts 的 @fastify/multipart limits.fileSize 兜底 → reason 'too-large'。
 */
export type ConsumedImage =
  | {
      kind: 'file';
      mimetype: string;
      buffer: Buffer;
      w: number;
      h: number;
    }
  | { kind: 'rejected'; reason: 'no-file' | 'wrong-type' | 'too-large' };

/**
 * 图片上传服务。
 *
 * 普通图片（聊天相册）：零图片库依赖——@fastify/multipart 读到 buffer + magic number 校验，
 * 宽高由前端 createImageBitmap 读后随 FormData 带上（后端不解析图片内容）。
 *
 * 头像管线（saveAvatars）：引入 sharp 做服务端重写——decode→按 EXIF 正向→cover 裁剪→
 * 多档 webp 重编码。重写天然剥离 EXIF/恶意 chunk（防隐私泄露与 polyglot 载荷），
 * decode 非图片即抛错，像素上限防解压炸弹；多档供前端按位置取用省带宽。
 *
 * 设计：
 * - @fastify/multipart 内存模式：文件进 buffer，先做 magic number 校验再落盘。
 * - 真实性校验两道：consumeImage 看 mimetype（粗筛，buffer 前即拒）+ isImage 读文件头 magic number（防伪造）。
 *
 * 存储目录 process.cwd()/uploads，与 main.ts 的 @fastify/static prefix:'/uploads/' 对齐。
 * 生产换对象存储（S3/OSS/MinIO）时，仅改 save()/saveAvatars() 的写入目标 + url 生成，接口契约不变。
 */
@Injectable()
export class UploadService {
  readonly uploadDir = join(process.cwd(), 'uploads');

  /** 头像多档边长（2 的幂，覆盖侧栏/消息行/详情页 + retina）；按需可调。 */
  static readonly AVATAR_SIZES = [32, 64, 128, 256, 512] as const;
  /** 头像代表档：avatar 字段存该档完整 URL，其余档由前端 avatarUrl() 派生。 */
  static readonly AVATAR_MAX = 512;
  /** 头像像素上限（防解压炸弹：小文件解压成超大画布吃内存）。 */
  static readonly MAX_AVATAR_PIXELS = 4000 * 4000;

  /**
   * 从 multipart/form-data 请求里消费单张图片：单遍遍历 parts，粗筛 mimetype 后 toBuffer。
   * 替代 Express 时代的 multer FileInterceptor（Fastify 适配器下不可用）。
   * 10MB 上限由 main.ts 注册插件时的 limits.fileSize 兜底——超出时 toBuffer 抛
   * RequestFileTooLargeError，此处归一为 rejected('too-large')，避免被全局过滤器当 500。
   */
  async consumeImage(req: FastifyRequest): Promise<ConsumedImage> {
    let filePart: MultipartFile | undefined;
    const fields: Record<string, string> = {};
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        if (filePart) {
          // 单文件契约：多出的文件直接排空，避免背压卡住解析流。
          part.file.resume();
          continue;
        }
        // 粗筛 mimetype（可伪造）：不匹配白名单立即拒，不进 buffer。
        if (!(part.mimetype in IMG_EXT)) {
          part.file.resume();
          return { kind: 'rejected', reason: 'wrong-type' };
        }
        filePart = part;
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }

    if (!filePart) return { kind: 'rejected', reason: 'no-file' };

    let buffer: Buffer;
    try {
      buffer = await filePart.toBuffer();
    } catch {
      // 体积超限（RequestFileTooLargeError）或流错误：统一归为 too-large。
      return { kind: 'rejected', reason: 'too-large' };
    }
    return {
      kind: 'file',
      mimetype: filePart.mimetype,
      buffer,
      w: Number(fields.w) || 0,
      h: Number(fields.h) || 0,
    };
  }

  /**
   * magic number 二次校验：读真实文件头字节判定是否为声明的图片格式。
   * consumeImage 的粗筛只看客户端声明的 mimetype（可伪造），此处不可绕过。
   */
  isImage(mimetype: string, buf: Buffer): boolean {
    if (!buf || buf.length < 12) return false;
    switch (mimetype) {
      case 'image/png':
        return (
          buf[0] === 0x89 &&
          buf[1] === 0x50 &&
          buf[2] === 0x4e &&
          buf[3] === 0x47
        );
      case 'image/jpeg':
        return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
      case 'image/gif':
        return (
          buf[0] === 0x47 &&
          buf[1] === 0x49 &&
          buf[2] === 0x46 &&
          buf[3] === 0x38
        );
      case 'image/webp':
        return buf.slice(8, 12).toString('ascii') === 'WEBP';
      default:
        return false;
    }
  }

  /** 确保 uploads/ 存在（save 与 saveAvatars 共用）。 */
  private ensureDir() {
    if (!existsSync(this.uploadDir)) {
      mkdirSync(this.uploadDir, { recursive: true });
    }
  }

  /** 落盘到 uploads/，返回可访问的 url（与 main.ts 的 @fastify/static prefix:'/uploads/' 对齐）。 */
  async save(mimetype: string, buf: Buffer): Promise<string> {
    this.ensureDir();
    const ext = IMG_EXT[mimetype];
    const filename = `${Date.now()}-${randomBytes(6).toString('hex')}.${ext}`;
    await writeFileAsync(join(this.uploadDir, filename), buf);
    return `/uploads/${filename}`;
  }

  /**
   * 头像专用：sharp decode→按 EXIF 正向→cover 裁剪正方形→多档 webp 重编码。
   * - 重写剥离 EXIF/恶意 chunk（防隐私泄露与 polyglot 载荷）；sharp decode 非图片即抛错；
   * - 像素上限防解压炸弹；多档供前端按位置取用省带宽。
   * 返回最大档 URL 作代表，其余档按 /uploads/<base>-<size>.webp 由前端 avatarUrl() 派生。
   */
  async saveAvatars(buf: Buffer): Promise<string> {
    this.ensureDir();
    const meta = await sharp(buf).metadata();
    if (
      (meta.width ?? 0) * (meta.height ?? 0) >
      UploadService.MAX_AVATAR_PIXELS
    ) {
      throw new Error('avatar too large in pixels');
    }
    const base = `${Date.now()}-${randomBytes(6).toString('hex')}`;
    const src = sharp(buf).rotate();
    for (const size of UploadService.AVATAR_SIZES) {
      const out = await src
        .clone()
        .resize(size, size, { fit: 'cover', position: 'center' })
        .webp({ quality: 85 })
        .toBuffer();
      await writeFileAsync(join(this.uploadDir, `${base}-${size}.webp`), out);
    }
    return `/uploads/${base}-${UploadService.AVATAR_MAX}.webp`;
  }

  /**
   * 按 URL 删除落盘文件：多尺寸头像删该 base 全部档；单文件（外链/旧格式）删单个；非 /uploads/ 跳过。
   * 头像一人一份无共享，删除失败一律静默（unlink ENOENT 不影响主流程）。
   */
  async deleteByUrl(url: string): Promise<void> {
    if (!url?.startsWith('/uploads/')) return;
    const m = url.match(/^\/uploads\/(.+)-\d+\.webp$/);
    if (m) {
      const base = m[1];
      for (const size of UploadService.AVATAR_SIZES) {
        await unlinkAsync(join(this.uploadDir, `${base}-${size}.webp`)).catch(
          () => {},
        );
      }
    } else {
      await unlinkAsync(
        join(this.uploadDir, url.slice('/uploads/'.length)),
      ).catch(() => {});
    }
  }
}
