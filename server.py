"""YENGolf single-server application. Python 3.12+, standard library only."""
import argparse
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import sqlite3
import threading
import time
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs

ROOT = Path(__file__).resolve().parent
ROLES = {"bar", "reception", "admin"}


def deployment_origin():
    # Render supplies its assigned HTTPS origin. A custom domain overrides it explicitly.
    return os.environ.get("VC_PUBLIC_URL") or os.environ.get("RENDER_EXTERNAL_URL", "")


class Problem(Exception):
    def __init__(self, message, status=400):
        self.message, self.status = message, status


def require(test, message, status=400):
    if not test:
        raise Problem(message, status)


def integer(value, low=1, high=100000000):
    require(type(value) is int and low <= value <= high, "Invalid whole-number amount or quantity.")
    return value


def text(value, limit=500):
    require(isinstance(value, str) and len(value) <= limit, "Invalid text field.")
    return value.strip()


def stamp():
    return int(time.time() * 1000)


def digest(password, salt):
    return hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()


class Club:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.lock = threading.RLock()
        self.changed = threading.Condition(self.lock)
        self.version = 0
        self.logins = {}
        self.credentials = {}
        credential_file = self.directory / "staff.json"
        if credential_file.exists():
            self.credentials = json.loads(credential_file.read_text())
        for role in ROLES:
            password = os.environ.get("VC_" + role.upper() + "_PASSWORD")
            if password:
                salt = secrets.token_hex(16)
                self.credentials[role] = {"salt": salt, "hash": digest(password, salt)}
        self.db = sqlite3.connect(self.directory / "club.sqlite3", check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("CREATE TABLE IF NOT EXISTS club (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL)")
        self.db.execute("CREATE TABLE IF NOT EXISTS auth (token TEXT PRIMARY KEY, role TEXT, expires REAL)")
        row = self.db.execute("SELECT payload FROM club WHERE id=1").fetchone()
        self.state = json.loads(row[0]) if row else {
            "bays": [{"id": i, "active": False, "session": None, "name": "", "phone": "", "guests": 0, "opened": None} for i in range(1, 7)],
            "orders": [], "payments": [], "sessions": [], "audit": [], "seq": 1,
            "products": json.loads((ROOT / "data/menu.json").read_text())}
        self.persist()

    def persist(self):
        self.db.execute("INSERT OR REPLACE INTO club VALUES(1,?)", (json.dumps(self.state),))
        self.db.commit()

    def role(self, token):
        with self.lock:
            row = self.db.execute("SELECT role FROM auth WHERE token=? AND expires>?", (hashlib.sha256(token.encode()).hexdigest(), time.time())).fetchone()
            return row[0] if row else None

    def login(self, data, ip):
        role, password = data.get("role"), data.get("password", "")
        require(role in ROLES and isinstance(password, str) and len(password) <= 512, "Invalid credentials.", 401)
        with self.lock:
            attempts = [t for t in self.logins.get(ip, []) if t > time.time() - 300]
            require(len(attempts) < 10, "Too many login attempts. Try again in five minutes.", 429)
            attempts.append(time.time())
            self.logins[ip] = attempts
            record = self.credentials.get(role)
            require(record and hmac.compare_digest(record["hash"], digest(password, record["salt"])), "Invalid credentials.", 401)
            token = secrets.token_urlsafe(32)
            self.db.execute("DELETE FROM auth WHERE expires<?", (time.time(),))
            self.db.execute("INSERT INTO auth VALUES(?,?,?)", (hashlib.sha256(token.encode()).hexdigest(), role, time.time() + 28800))
            self.db.commit()
            return token

    def bay(self, bid):
        require(type(bid) is int, "Invalid bay.")
        b = next((b for b in self.state["bays"] if b["id"] == bid), None)
        require(b is not None, "Bay not found.", 404)
        return b

    def orders(self, session):
        return [o for o in self.state["orders"] if o["session"] == session]

    def due(self, session):
        total = sum(o["total"] for o in self.orders(session) if o["status"] != "cancelled")
        paid = sum(p["amount"] for p in self.state["payments"] if p["session"] == session)
        return total - paid

    def snapshot(self, role, bid):
        with self.lock:
            products = [p for p in self.state["products"] if p["active"] or role == "admin"]
            result = {"products": products, "role": role, "version": self.version}
            if role:
                # Bar does not need customer contact details or payment references.
                result.update({k: self.state[k] for k in ["bays", "orders"]})
                if role == "bar":
                    result["bays"] = [{k: v for k, v in b.items() if k not in ["name", "phone"]} for b in self.state["bays"]]
                else:
                    result["payments"] = self.state["payments"]
                    result["sessions"] = self.state["sessions"]
                if role == "admin":
                    result["audit"] = self.state["audit"]
            elif bid:
                b = self.bay(bid)
                result["bays"] = [{k: b[k] for k in ["id", "active", "session"]}]
                result["orders"] = self.orders(b["session"]) if b["active"] else []
                result["payments"] = [{"amount": p["amount"], "session": p["session"]} for p in self.state["payments"] if p["session"] == b["session"]]
            else:
                result.update(bays=[], orders=[], payments=[])
            return json.loads(json.dumps(result))

    def mutate(self, action, d, role):
        with self.changed:
            before = json.dumps(self.state)
            try:
                result = self._mutate(action, d, role)
                self.state["audit"].append({"at": stamp(), "actor": role or "customer", "action": action, "subject": result.get("id", result.get("bay"))})
                self.persist()
            except Exception:
                self.db.rollback()
                self.state = json.loads(before)
                raise
            self.version += 1
            self.changed.notify_all()
            return result

    def _mutate(self, action, d, role):
        s = self.state
        if action == "orders":
            require(role in [None, "bar", "reception", "admin"], "Forbidden.", 403)
            b = self.bay(d.get("bay"))
            require(b["active"], "This bay is not currently checked in.", 409)
            require(d.get("session") == b["session"], "This bay session changed. Reload before ordering.", 409)
            key = text(d.get("key", ""), 100)
            require(len(key) >= 12, "An order request key is required.")
            previous = next((o for o in self.orders(b["session"]) if o["key"] == key), None)
            if previous:
                return {"id": previous["id"]}
            items = d.get("items")
            require(isinstance(items, list) and 0 < len(items) <= 100, "Add at least one item (maximum 100 lines).")
            lines = []
            for line in items:
                require(isinstance(line, dict), "Invalid order item.")
                p = next((p for p in s["products"] if p["id"] == line.get("product")), None)
                require(p and p["active"] and p["available"], "An item is unavailable.", 409)
                option = next((o for o in p["options"] if o["id"] == line.get("option")), None)
                require(option is not None, "Select a valid product option.")
                qty = integer(line.get("qty"), 1, 99)
                lines.append({"product": p["id"], "option": option["id"], "name": p["name"], "serving": option["label"], "qty": qty, "price": option["price"]})
            oid = "VC" + str(s["seq"]).zfill(3)
            s["seq"] += 1
            s["orders"].append({"id": oid, "bay": b["id"], "session": b["session"], "key": key, "items": lines, "total": sum(i["qty"] * i["price"] for i in lines), "note": text(d.get("note", "")), "mixers": text(d.get("mixers", ""), 200), "source": role.upper() if role else "CUSTOMER", "status": "new", "created": stamp(), "accepted": None, "served": None})
            return {"id": oid}
        require(role is not None, "Staff sign-in required.", 401)
        if action == "status":
            require(role in ["bar", "admin"], "Only Bar staff can fulfil orders.", 403)
            o = next((o for o in s["orders"] if o["id"] == d.get("id")), None)
            require(o is not None, "Order not found.", 404)
            status = d.get("status")
            allowed = {"new": ["preparing", "cancelled"], "preparing": ["served", "cancelled"]}
            require(status in allowed.get(o["status"], []), "Invalid order transition.", 409)
            if status == "cancelled":
                reason = text(d.get("reason", ""), 200)
                require(reason, "A cancellation reason is required.")
                require(self.due(o["session"]) >= o["total"], "This order has been paid. Refund processing is required before cancellation.", 409)
                o.update(reason=reason, cancelled=stamp())
            else:
                o["accepted" if status == "preparing" else "served"] = stamp()
            o["status"] = status
            return {"id": o["id"]}
        if action in ["open", "close", "payment"]:
            require(role in ["reception", "admin"], "Reception permission required.", 403)
            b = self.bay(d.get("bay"))
            if action == "open":
                require(not b["active"], "Bay is already open.", 409)
                name = text(d.get("name", ""), 100)
                require(name, "Customer name is required.")
                sid = secrets.token_urlsafe(18)
                b.update(active=True, session=sid, name=name, phone=text(d.get("phone", ""), 40), guests=integer(d.get("guests"), 1, 50), opened=stamp())
                s["sessions"].append({**b, "closed": None})
            else:
                require(b["active"] and d.get("session") == b["session"], "Bay session changed.", 409)
                unresolved = any(o["status"] in ["new", "preparing"] for o in self.orders(b["session"]))
                # Settle only final orders so subsequent cancellation cannot create an overpayment.
                require(not unresolved, "Serve or cancel all active orders before settlement or closing.", 409)
                if action == "payment":
                    payments = d.get("payments")
                    require(isinstance(payments, list) and 0 < len(payments) <= 10, "Provide payment details.")
                    total = self.due(b["session"])
                    require(total > 0, "There is no outstanding balance.", 409)
                    require(sum(integer(p.get("amount")) for p in payments if isinstance(p, dict)) == total and all(isinstance(p, dict) for p in payments), "Payments must equal the outstanding balance.")
                    receipt = "RC" + str(len(s["payments"]) + 1).zfill(5)
                    billed = {oid for p in s["payments"] if p["session"] == b["session"] for oid in p.get("order_ids", [])}
                    order_ids = [o["id"] for o in self.orders(b["session"]) if o["status"] != "cancelled" and o["id"] not in billed]
                    for p in payments:
                        require(p.get("method") in ["M-Pesa", "Card", "Cash"], "Invalid payment method.")
                        reference = text(p.get("reference", ""), 100)
                        require(p["method"] != "M-Pesa" or reference, "M-Pesa reference is required.")
                        s["payments"].append({"bay": b["id"], "session": b["session"], "receipt": receipt, "order_ids": order_ids, "amount": p["amount"], "method": p["method"], "reference": reference, "time": stamp()})
                    return {"id": receipt}
                require(self.due(b["session"]) == 0, "Settle the unpaid balance before closing.", 409)
                next(x for x in s["sessions"] if x["session"] == b["session"])["closed"] = stamp()
                b.update(active=False, session=None, name="", phone="", guests=0, opened=None)
            return {"bay": b["id"]}
        if action == "product":
            require(role in ["bar", "admin"], "Menu permission required.", 403)
            p = next((p for p in s["products"] if p["id"] == d.get("id")), None)
            if role == "bar":
                require(p is not None and type(d.get("available")) is bool, "Invalid product.")
                p["available"] = d["available"]
            else:
                name, cat = text(d.get("name", ""), 120), text(d.get("cat", ""), 60)
                require(name and cat, "Name and category are required.")
                options = d.get("options", [])
                require(isinstance(options, list) and len(options) <= 5, "Invalid product options.")
                clean = []
                for i, option in enumerate(options):
                    require(isinstance(option, dict), "Invalid product option.")
                    label = text(option.get("label", ""), 30)
                    require(label, "Option label is required.")
                    clean.append({"id": option.get("id") or secrets.token_hex(8), "label": label, "price": integer(option.get("price"))})
                require(len({o["id"] for o in clean}) == len(clean), "Duplicate option identifiers.")
                require(type(d.get("available")) is bool and type(d.get("active")) is bool, "Invalid availability.")
                require(not d["available"] or clean, "Set a confirmed price before enabling a product.")
                values = {"name": name, "cat": cat, "options": clean, "available": d["available"], "active": d["active"], "flag": text(d.get("flag", ""), 200)}
                if p:
                    p.update(values)
                else:
                    p = {"id": secrets.token_hex(8), **values}
                    s["products"].append(p)
            return {"id": p["id"]}
        raise Problem("Unknown action.", 404)


class Handler(BaseHTTPRequestHandler):
    server_version = "YENGolf"

    def log_message(self, fmt, *args):
        # Do not log URLs, credentials, or guest data.
        pass

    def headers_common(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")

    def reply(self, code, data, cookie=None):
        payload = json.dumps(data).encode()
        self.send_response(code)
        self.headers_common()
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(payload)))
        if cookie is not None:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(payload)

    def token(self):
        c = cookies.SimpleCookie()
        try:
            c.load(self.headers.get("Cookie", ""))
            return c["vc_staff"].value if "vc_staff" in c else ""
        except cookies.CookieError:
            return ""

    def do_GET(self):
        try:
            u = urlsplit(self.path)
            role = self.server.club.role(self.token())
            if u.path == "/api/state":
                bid = parse_qs(u.query).get("bay", [None])[0]
                require(bid is None or bid.isdigit(), "Invalid bay.")
                self.reply(200, self.server.club.snapshot(role, int(bid) if bid else None))
            elif u.path == "/api/events":
                self.send_response(200)
                self.headers_common()
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("X-Accel-Buffering", "no")
                self.end_headers()
                version = -1
                for _ in range(120):
                    with self.server.club.changed:
                        if version == self.server.club.version:
                            self.server.club.changed.wait(timeout=15)
                        version = self.server.club.version
                    self.wfile.write(f"data: {version}\n\n".encode())
                    self.wfile.flush()
            elif u.path == "/api/health":
                self.reply(200, {"ok": True})
            elif u.path in ["/api/qr-info", "/api/qr-codes.pdf"]:
                require(role in ["reception", "admin"], "Reception sign-in required.", 401 if not role else 403)
                from qr_codes import public_origin, bay_urls, printable_pdf
                try:
                    origin = public_origin(deployment_origin())
                except ValueError as error:
                    raise Problem(str(error), 409) from error
                with self.server.club.lock:
                    bays = [b["id"] for b in self.server.club.state["bays"]]
                if u.path == "/api/qr-info":
                    self.reply(200, {"origin": origin, "bays": bay_urls(origin, bays)})
                else:
                    content = printable_pdf(origin, bays)
                    self.send_response(200)
                    self.headers_common()
                    self.send_header("Content-Type", "application/pdf")
                    self.send_header("Content-Disposition", 'attachment; filename="YENGolf-bay-QR-codes.pdf"')
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("Content-Length", str(len(content)))
                    self.end_headers()
                    self.wfile.write(content)
            else:
                mapping = {"/": "index.html", "/bar": "index.html", "/reception": "index.html", "/admin": "index.html"}
                path = ROOT / "static" / mapping.get(u.path, "index.html" if u.path.startswith("/bay/") else u.path.lstrip("/"))
                require(path.resolve().is_relative_to((ROOT / "static").resolve()) and path.is_file(), "Not found.", 404)
                mime = {".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".svg": "image/svg+xml", ".ttf": "font/ttf", ".txt": "text/plain"}.get(path.suffix, "application/octet-stream")
                content = path.read_bytes()
                self.send_response(200)
                self.headers_common()
                self.send_header("Content-Type", mime)
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Content-Length", str(len(content)))
                self.end_headers()
                self.wfile.write(content)
        except Problem as e:
            self.reply(e.status, {"error": e.message})
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self):
        try:
            # All writes require JSON and same-origin browser requests. No CORS grants.
            origin = self.headers.get("Origin")
            expected = deployment_origin() or "http://" + self.headers.get("Host", "")
            require(not origin or origin.rstrip("/") == expected.rstrip("/"), "Cross-origin request rejected.", 403)
            require(self.headers.get("Content-Type", "").split(";")[0] == "application/json", "JSON required.", 415)
            length = int(self.headers.get("Content-Length", "0"))
            require(0 < length <= 65536, "Invalid request size.", 413)
            d = json.loads(self.rfile.read(length))
            require(isinstance(d, dict), "JSON object required.")
            action = urlsplit(self.path).path.removeprefix("/api/")
            if action == "login":
                token = self.server.club.login(d, self.client_address[0])
                secure = "; Secure" if expected.startswith("https:") else ""
                self.reply(200, {"ok": True}, f"vc_staff={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800{secure}")
            elif action == "logout":
                with self.server.club.lock:
                    self.server.club.db.execute("DELETE FROM auth WHERE token=?", (hashlib.sha256(self.token().encode()).hexdigest(),))
                    self.server.club.db.commit()
                self.reply(200, {"ok": True}, "vc_staff=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0")
            else:
                self.reply(200, self.server.club.mutate(action, d, self.server.club.role(self.token())))
        except Problem as e:
            self.reply(e.status, {"error": e.message})
        except (ValueError, TypeError, KeyError):
            self.reply(400, {"error": "Invalid request fields."})
        except (BrokenPipeError, ConnectionResetError):
            pass


def init_staff(directory):
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = directory / "staff.json"
    if path.exists():
        return
    credentials, passwords = {}, {}
    for role in sorted(ROLES):
        password, salt = secrets.token_urlsafe(18), secrets.token_hex(16)
        credentials[role] = {"salt": salt, "hash": digest(password, salt)}
        passwords[role] = password
    with path.open("x") as f:
        os.chmod(path, 0o600)
        json.dump(credentials, f)
    pwpath = directory / "initial-passwords.json"
    with pwpath.open("x") as f:
        os.chmod(pwpath, 0o600)
        json.dump(passwords, f)
    print(f"Created local staff credentials. Retrieve passwords securely from {pwpath}; do not commit or share them.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8080")))
    parser.add_argument("--init-staff", action="store_true")
    args = parser.parse_args()
    directory = Path(os.environ.get("VC_DATA_DIR", str(ROOT / ".runtime")))
    if args.init_staff:
        init_staff(directory)
    else:
        club = Club(directory)
        if not club.credentials:
            raise SystemExit("Configure VC_BAR_PASSWORD, VC_RECEPTION_PASSWORD and VC_ADMIN_PASSWORD, or run --init-staff for local development.")
        if deployment_origin():
            from qr_codes import public_origin
            try:
                public_origin(deployment_origin())
            except ValueError as error:
                raise SystemExit(str(error)) from error
            if set(club.credentials) != ROLES:
                raise SystemExit("All three staff role passwords are required for a public deployment.")
        server = ThreadingHTTPServer((args.host, args.port), Handler)
        server.daemon_threads = True
        server.club = club
        print(f"YENGolf server listening on {args.host}:{args.port}", flush=True)
        server.serve_forever()
