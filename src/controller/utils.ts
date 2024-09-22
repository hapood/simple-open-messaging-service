export function toJson(param: any) {
  return JSON.stringify(
    param,
    (key, value) => {
      if (typeof value === "bigint") {
        return value.toString()
      } else {
        return value
      }
    }
  );
};

export interface StandardResponse<T = any> {
  status: number,
  message: string,
  data?: T
}