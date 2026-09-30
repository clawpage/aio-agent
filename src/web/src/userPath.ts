/** Every account's console lives at `/u/<username>`; the session decides whose data it shows. */
const USER_PATH = /^\/u\/([A-Za-z0-9_-]{2,40})(?:\/|$)/;

export const homePath = (username: string) => `/u/${username}`;

/** The account the address names, if any. */
export function pathUser(pathname = location.pathname): string | null {
  return USER_PATH.exec(pathname)?.[1] ?? null;
}
