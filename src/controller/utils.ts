export function convertBigIntId(obj: Record<string, any> & { id: bigint }) {
  (obj as any).id = obj.id.toString();
}

// 统一响应信封已迁移至 src/common/api-result.ts 的 ApiResult<T>（P1a）。
