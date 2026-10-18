/** URLSearchParams that refuses mutation, as next/navigation's hooks return. */
export class ReadonlyURLSearchParams extends URLSearchParams {
  append() {
    throw new ReadonlyError();
  }
  delete() {
    throw new ReadonlyError();
  }
  set() {
    throw new ReadonlyError();
  }
  sort() {
    throw new ReadonlyError();
  }
}

class ReadonlyError extends Error {
  constructor() {
    super("Method unavailable on `ReadonlyURLSearchParams`. Read more: https://nextjs.org/docs/app/api-reference/functions/use-search-params#updating-searchparams");
  }
}
