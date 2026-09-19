export interface ApiSuccessResponse<T> {
  data: T;
  error: null;
  meta: null;
}

export function okResponse<T>(data: T): ApiSuccessResponse<T> {
  return {
    data,
    error: null,
    meta: null,
  };
}
