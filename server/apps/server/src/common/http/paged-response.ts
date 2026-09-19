export interface ApiPagedResponse<T, M> {
  data: T;
  error: null;
  meta: M;
}

export function pagedResponse<T, M>(data: T, meta: M): ApiPagedResponse<T, M> {
  return {
    data,
    error: null,
    meta,
  };
}
