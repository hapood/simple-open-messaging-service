export function convertBigIntId(obj: Record<string, any> & { id: bigint }) {
  (obj as any).id = obj.id.toString()
};

export interface StandardResponse<T = any> {
  status: number,
  message: string,
  data?: T
}