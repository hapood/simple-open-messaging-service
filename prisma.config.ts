import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// Prisma 7 CLI 配置（取代 schema 中 datasource.url 的 CLI 用途）。
// `import 'dotenv/config'` 让 CLI（migrate/generate）自加载 .env，
// 不再需要运行前手动 `source .env`。
// 用 process.env 而非类型安全的 env()：generate 不需要连接串，
// 这样在未设置 DATABASE_URL 时 generate 仍可运行（postinstall 场景）。
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.DATABASE_URL,
  },
  migrations: {
    path: 'prisma/migrations',
  },
});
