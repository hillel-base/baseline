"""Server mode (the practice server): who a Base44 token belongs to, asked of Base44 itself and kept for a few minutes."""
import hashlib
import json
import time
import urllib.request

APP_ID = "6ade4e48cef18b0e709ec964"  # the hosted page's app (the page itself shows it too)
BASE_URL = "https://base44.app"
now = time.monotonic  # looked up through the module: tests replace it


def allowed(user: dict) -> bool:
    return True  # an allow-list, if one is ever needed, changes only this function


class Verifier:
    """Caches valid answers only, by the token's SHA-256: the token itself is never kept."""

    def __init__(self, check, ttl_s=300):
        self.check, self.ttl_s, self.cache = check, ttl_s, {}

    def cached(self, token: str) -> dict | None:  # never asks Base44: safe on the event loop
        hit = self.cache.get(hashlib.sha256(token.encode()).hexdigest())
        return hit[0] if hit and now() < hit[1] else None

    def __call__(self, token: str) -> dict | None:
        user = self.cached(token)
        if user is None and (user := self.check(token)) is not None:
            t = now()
            self.cache = {k: v for k, v in self.cache.items() if v[1] > t} | {hashlib.sha256(token.encode()).hexdigest(): (user, t + self.ttl_s)}  # drops expired answers
        return user


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a):  # urllib would resend the token to the new address
        return None


def base44_verifier(app_id=APP_ID, base_url=BASE_URL, timeout=5) -> Verifier:
    url, opener = f"{base_url}/api/apps/{app_id}/entities/User/me", urllib.request.build_opener(_NoRedirect)

    def check(token):
        try:  # shortcut: timeout is per socket step, not in total; fine against Base44, revisit if it ever drips slowly
            with opener.open(urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"}), timeout=timeout) as r:
                user = json.loads(r.read())
        except Exception:  # refused (403), a redirect, timeout, network down, not JSON: not signed in
            return None
        return user if isinstance(user, dict) and user.get("id") else None
    return Verifier(check)
