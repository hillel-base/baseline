export type User = { id: string; email: string; full_name: string }; // id: Base44's own user id (auth.me().id)
export type Session = { kind: "user"; user: User } | { kind: "signin" } | { kind: "error"; message: string };
export const INVITE_ONLY = "You are signed in, but this app is invite-only. Ask the app's admin for an invite.";
export const NO_BASE44 = "Could not reach Base44. Reload to try again.";
const GUARD = "lung.signin.tried";

/** currentUser resolves null for "not signed in" (401/403) and throws for anything else. At most one sign-in redirect per page load:
 *  the guard survives the bounce through Base44's sign-in and clears on a signed-in load, so a second redirect shows the message instead. */
export async function resolveSession(
  currentUser: () => Promise<User | null>, signIn: () => void, store: Pick<Storage, "getItem" | "setItem" | "removeItem">, configError?: string,
): Promise<Session> {
  if (configError) return { kind: "error", message: configError };
  let user: User | null;
  let forbidden = false; // 403: Base44 knows the person but the app is not open to them (or nobody is signed in yet: the one redirect tells the two apart)
  try { user = await currentUser(); } catch (e) { if ((e as { status?: number }).status !== 403) return { kind: "error", message: NO_BASE44 }; user = null; forbidden = true; }
  if (user) { try { store.removeItem(GUARD); } catch { /* storage blocked */ } return { kind: "user", user }; }
  try {
    if (store.getItem(GUARD)) { store.removeItem(GUARD); return { kind: "error", message: forbidden ? INVITE_ONLY : NO_BASE44 }; } // a reload then tries once more
    store.setItem(GUARD, "1");
  } catch { return { kind: "error", message: NO_BASE44 }; } // cannot guard against a loop: do not redirect
  signIn();
  return { kind: "signin" };
}

/** `sessionStorage` itself throws a SecurityError when storage is blocked. A memory fallback would reset on every load and
 *  could not stop a sign-in loop, so a blocked store throws on use: `resolveSession` then shows the message, never redirects. */
export function guardStore(get: () => Storage = () => sessionStorage): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  try { return get(); } catch {
    const blocked = () => { throw new Error("storage blocked"); };
    return { getItem: blocked, setItem: blocked, removeItem: blocked };
  }
}
