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

export interface StandardResponse {
  status: number,
  message: string,
  data?: any
}