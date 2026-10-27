import { createClient, getAccessToken } from "@base44/sdk";
import * as fake from "./base44.fake";

// A private app: Base44's own sign-in page sets the session; the SDK reads the token (URL ?access_token=… or localStorage
// "base44_access_token"), so me() is the only check we need. Created lazily, so the test build never builds a real client.
export type Rec = Record<string, any> & { id: string };
export type Store = { filter(q: Record<string, unknown>): Promise<Rec[]>; create(o: Record<string, unknown>): Promise<Rec>; list(): Promise<Rec[]> };
let client: ReturnType<typeof createClient> | undefined;
const base44 = () => (client ??= createClient({ appId: import.meta.env.VITE_BASE44_APP_ID as string, appBaseUrl: window.location.origin }));

// 5000: the SDK's default page is small; one study will not reach this. shortcut: no paging, upgrade when a table passes it.
const store = (name: "Scan" | "NoduleMeasurement"): Store => ({
  filter: (q) => base44().entities[name].filter(q, "created_date", 5000) as Promise<Rec[]>, // oldest first: a Record goes to a scan's oldest Scan row
  create: (o) => base44().entities[name].create(o) as Promise<Rec>,
  list: () => base44().entities[name].list("created_date", 5000) as Promise<Rec[]>,
});

const real = {
  currentUser: async (): Promise<{ id: string; email: string; full_name: string } | null> => {
    try { const u = await base44().auth.me(); return { id: u.id, email: u.email ?? "", full_name: u.full_name ?? "" }; } catch (e) {
      const status = (e as { status?: number }).status; // Base44Error.status
      if (status === 401) return null; // not signed in; a 403 is thrown so the session can tell "not invited" after one sign-in; anything else too
      throw e;
    }
  },
  signIn: () => base44().auth.redirectToLogin(window.location.href),
  signOut: () => base44().auth.logout(window.location.href),
  accessToken: (): string | undefined => getAccessToken() ?? undefined, // the SDK's own reader, the one its client sends: URL ?access_token=… or localStorage
  entities: {
    Scan: store("Scan"), NoduleMeasurement: store("NoduleMeasurement"),
  },
};
// The flag is replaced at build time, so the unused branch (and the SDK) drops out of the test build.
export const { currentUser, signIn, signOut, accessToken, entities } = import.meta.env.VITE_BASE44_FAKE === "1" ? fake : real;
// An empty app id would send every call to a wrong app: say so before any SDK call.
export const configError = import.meta.env.VITE_BASE44_FAKE === "1" || import.meta.env.VITE_BASE44_APP_ID
  ? undefined : "This build has no Base44 app id; build it with VITE_BASE44_APP_ID set.";
