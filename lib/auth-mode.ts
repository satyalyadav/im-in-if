export const LOCAL_USER_COOKIE = "im_in_if_local_user";

export function isLocalAuth(): boolean {
  return process.env.AUTH_MODE === "local";
}

export function assertLocalAuthAllowed(): void {
  if (process.env.NODE_ENV === "production" || process.env.VERCEL) {
    throw new Error("AUTH_MODE=local is development-only");
  }
}

export function isValidLocalUserId(value: string): boolean {
  return /^[A-Za-z0-9_-]{3,64}$/.test(value);
}
