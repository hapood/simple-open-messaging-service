import { Injectable } from '@nestjs/common';
import { memoryStorage } from 'multer';
import { existsSync, mkdirSync, writeFile } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { promisify } from 'util';

const writeFileAsync = promisify(writeFile);

const MAX_SIZE = 10 * 1024 * 1024; // 10MB

/** 允许的图片 mimetype → 扩展名（白名单 + 落盘扩展名映射）。 */
const IMG_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/**
 * 图片上传服务（零图片库依赖——不引入 sharp）。
 *
 * 设计：
 * - multer 用 memoryStorage：文件进 buffer，先做 magic number 校验再落盘（diskStorage
 *   会先落盘再校验，伪造文件会残留在磁盘）。
 * - 宽高由前端用 createImageBitmap 读后随 FormData 带上（后端不解析图片内容）。
 * - 真实性校验两道：multer fileFilter 看 mimetype（粗筛）+ isImage 读文件头 magic number（防伪造）。
 *
 * 存储目录 process.cwd()/uploads，与 main.ts 的 useStaticAssets prefix:'/uploads/' 对齐。
 * 生产换对象存储（S3/OSS/MinIO）时，仅改 save() 的写入目标 + url 生成，接口契约不变。
 */
@Injectable()
export class UploadService {
  readonly uploadDir = join(process.cwd(), 'uploads');

  /** multer 配置（静态：装饰器 @UseInterceptors 求值时无实例可用）。 */
  static readonly multerOptions = {
    storage: memoryStorage(),
    limits: { fileSize: MAX_SIZE },
    fileFilter: (
      _req: Express.Request,
      file: Express.Multer.File,
      cb: (error: Error | null, acceptFile: boolean) => void,
    ) => {
      cb(null, file.mimetype in IMG_EXT);
    },
  };

  /**
   * magic number 二次校验：读真实文件头字节判定是否为声明的图片格式。
   * multer 的 fileFilter 只看客户端声明的 mimetype（可伪造），此处不可绕过。
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

  /** 落盘到 uploads/，返回可访问的 url（与 main.ts useStaticAssets prefix 对齐）。 */
  async save(mimetype: string, buf: Buffer): Promise<string> {
    if (!existsSync(this.uploadDir)) {
      mkdirSync(this.uploadDir, { recursive: true });
    }
    const ext = IMG_EXT[mimetype];
    const filename = `${Date.now()}-${randomBytes(6).toString('hex')}.${ext}`;
    await writeFileAsync(join(this.uploadDir, filename), buf);
    return `/uploads/${filename}`;
  }
}
