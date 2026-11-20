import hashlib
import json
import os
import secrets
import sqlite3
from datetime import datetime
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_NAME = os.path.join(BASE_DIR, "asistencia_dolorosa.db")
HTML_FILE = os.path.join(BASE_DIR, "index.html")

SESSIONS = {}


def hash_password(password: str, salt: str = None) -> str:
    if salt is None:
        salt = secrets.token_hex(16)
    pwd_hash = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt.encode("utf-8"), 100_000
    ).hex()
    return f"{salt}${pwd_hash}"


def verify_password(password: str, stored_value: str) -> bool:
    if "$" not in stored_value:
        return password == stored_value
    salt, _ = stored_value.split("$", 1)
    return secrets.compare_digest(hash_password(password, salt), stored_value)


def get_db():
    conn = sqlite3.connect(DB_NAME)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS usuarios (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            usuario TEXT UNIQUE NOT NULL,
            clave TEXT NOT NULL,
            nombre TEXT NOT NULL
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS estudiantes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cedula TEXT UNIQUE NOT NULL,
            nombres TEXT NOT NULL,
            curso TEXT NOT NULL,
            representante TEXT NOT NULL,
            telefono TEXT NOT NULL,
            estado_hoy TEXT DEFAULT 'Presente',
            faltas_acumuladas INTEGER DEFAULT 0
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS alertas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            estudiante_id INTEGER NOT NULL,
            tipo TEXT NOT NULL,
            detalle TEXT NOT NULL,
            fecha TEXT NOT NULL,
            notificado INTEGER DEFAULT 0,
            FOREIGN KEY (estudiante_id) REFERENCES estudiantes (id)
        )
    """)

    cursor.execute("SELECT COUNT(*) FROM usuarios")
    if cursor.fetchone()[0] == 0:
        cursor.execute(
            "INSERT INTO usuarios (usuario, clave, nombre) VALUES (?, ?, ?)",
            ("admin", hash_password("1234"), "Unidad Educativa La Dolorosa"),
        )

    cursor.execute("SELECT COUNT(*) FROM estudiantes")
    if cursor.fetchone()[0] == 0:
        estudiantes_iniciales = [
            ("0105487921", "Carlos Andrés Mendoza", "3ro BGU 'A'", "María Mendoza", "0991234567", "Ausente", 4),
            ("0106987412", "Sofía Valentina Torres", "2do BGU 'B'", "Jorge Torres", "0987654321", "Presente", 0),
            ("0107123456", "Mateo Sebastián Rivas", "1ro BGU 'A'", "Elena Rivas", "0998877665", "Fuga", 3),
            ("0105998877", "Camila Fernanda Ortiz", "3ro BGU 'A'", "Luis Ortiz", "0981122334", "Presente", 1),
            ("0106445566", "Diego Alejandro Vera", "10mo EGB 'C'", "Carmen Vera", "0994433221", "Atraso", 2),
            ("0107889900", "Valeria Nicole Paredes", "2do BGU 'B'", "Roberto Paredes", "0985566778", "Presente", 0),
        ]
        cursor.executemany("""
            INSERT INTO estudiantes (cedula, nombres, curso, representante, telefono, estado_hoy, faltas_acumuladas)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, estudiantes_iniciales)

        ahora = datetime.now().strftime("%Y-%m-%d %H:%M")
        alertas_iniciales = [
            (1, "Inasistencia Crítica", "4ta falta injustificada en el parcial", ahora, 0),
            (3, "Alerta de Fuga", "No ingresó a la 3ra hora de clase (Física)", ahora, 0),
            (5, "Atraso Reiterado", "Ingreso 07:25 AM sin justificación", ahora, 1),
        ]
        cursor.executemany("""
            INSERT INTO alertas (estudiante_id, tipo, detalle, fecha, notificado)
            VALUES (?, ?, ?, ?, ?)
        """, alertas_iniciales)

    conn.commit()
    conn.close()


class RequestHandler(BaseHTTPRequestHandler):
    def _get_session(self):
        raw_cookie = self.headers.get("Cookie", "")
        c = cookies.SimpleCookie()
        c.load(raw_cookie)
        if "sga_session" in c:
            token = c["sga_session"].value
            return SESSIONS.get(token)
        return None

    def _send_json(self, data, status=200, extra_headers=None):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if extra_headers:
            for k, v in extra_headers.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_GET(self):
        path = urlparse(self.path).path

        if path == "/" or path == "/index.html":
            if not os.path.exists(HTML_FILE):
                self.send_error(404, "No se encontro index.html")
                return
            with open(HTML_FILE, "rb") as f:
                content = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)
            return

        if path == "/api/session":
            user = self._get_session()
            if user:
                self._send_json({"ok": True, "cuenta": user})
            else:
                self._send_json({"ok": False}, status=401)
            return

        if not self._get_session():
            self._send_json({"ok": False, "mensaje": "No autorizado"}, status=401)
            return

        if path == "/api/dashboard":
            conn = get_db()
            estudiantes = [dict(row) for row in conn.execute("SELECT * FROM estudiantes ORDER BY curso, nombres").fetchall()]
            alertas = [dict(row) for row in conn.execute("""
                SELECT a.*, e.nombres, e.curso, e.representante, e.telefono, e.faltas_acumuladas
                FROM alertas a
                JOIN estudiantes e ON a.estudiante_id = e.id
                ORDER BY a.id DESC
            """).fetchall()]
            conn.close()

            total = len(estudiantes)
            presentes = sum(1 for e in estudiantes if e["estado_hoy"] == "Presente")
            ausentes = sum(1 for e in estudiantes if e["estado_hoy"] == "Ausente")
            atrasos = sum(1 for e in estudiantes if e["estado_hoy"] == "Atraso")
            fugas = sum(1 for e in estudiantes if e["estado_hoy"] == "Fuga")
            criticos = sum(1 for e in estudiantes if e["faltas_acumuladas"] >= 3 or e["estado_hoy"] == "Fuga")

            self._send_json({
                "metricas": {
                    "total": total,
                    "presentes": presentes,
                    "ausentes": ausentes,
                    "atrasos": atrasos,
                    "fugas": fugas,
                    "criticos": criticos,
                },
                "estudiantes": estudiantes,
                "alertas": alertas,
            })

        elif path == "/api/usuarios":
            conn = get_db()
            usuarios = [dict(row) for row in conn.execute("SELECT id, usuario, nombre FROM usuarios").fetchall()]
            conn.close()
            self._send_json({"usuarios": usuarios})

        else:
            self.send_error(404, "Ruta no encontrada")

    def do_POST(self):
        path = urlparse(self.path).path
        data = self._read_json()

        if path == "/api/login":
            usuario = data.get("usuario", "").strip()
            clave = data.get("clave", "").strip()
            conn = get_db()
            row = conn.execute(
                "SELECT id, usuario, clave, nombre FROM usuarios WHERE usuario = ?",
                (usuario,),
            ).fetchone()
            conn.close()

            if row and verify_password(clave, row["clave"]):
                token = secrets.token_urlsafe(32)
                user_data = {"id": row["id"], "usuario": row["usuario"], "nombre": row["nombre"]}
                SESSIONS[token] = user_data
                self._send_json(
                    {"ok": True, "cuenta": user_data},
                    extra_headers={"Set-Cookie": f"sga_session={token}; HttpOnly; Path=/; SameSite=Lax"},
                )
            else:
                self._send_json({"ok": False, "mensaje": "Credenciales incorrectas"}, status=401)
            return

        if path == "/api/logout":
            raw_cookie = self.headers.get("Cookie", "")
            c = cookies.SimpleCookie()
            c.load(raw_cookie)
            if "sga_session" in c:
                SESSIONS.pop(c["sga_session"].value, None)
            self._send_json(
                {"ok": True},
                extra_headers={"Set-Cookie": "sga_session=; HttpOnly; Path=/; Max-Age=0"},
            )
            return

        session_user = self._get_session()
        if not session_user:
            self._send_json({"ok": False, "mensaje": "No autorizado"}, status=401)
            return

        if path == "/api/asistencia/guardar":
            registros = data.get("registros", [])
            autor = session_user["nombre"]
            conn = get_db()
            cursor = conn.cursor()
            ahora = datetime.now().strftime("%Y-%m-%d %H:%M")

            for reg in registros:
                est_id = reg["id"]
                nuevo_estado = reg["estado"]
                est = cursor.execute("SELECT * FROM estudiantes WHERE id = ?", (est_id,)).fetchone()
                if not est:
                    continue

                estado_anterior = est["estado_hoy"]
                faltas = est["faltas_acumuladas"]

                if nuevo_estado in ("Ausente", "Fuga") and estado_anterior not in ("Ausente", "Fuga"):
                    faltas += 1
                elif nuevo_estado not in ("Ausente", "Fuga") and estado_anterior in ("Ausente", "Fuga"):
                    faltas = max(0, faltas - 1)

                cursor.execute(
                    "UPDATE estudiantes SET estado_hoy = ?, faltas_acumuladas = ? WHERE id = ?",
                    (nuevo_estado, faltas, est_id),
                )

                if nuevo_estado != "Presente" and nuevo_estado != estado_anterior:
                    cursor.execute(
                        "INSERT INTO alertas (estudiante_id, tipo, detalle, fecha, notificado) VALUES (?, ?, ?, ?, 0)",
                        (est_id, f"Reporte de {nuevo_estado}", f"Registrado por {autor} a las {ahora[-5:]}", ahora),
                    )

            conn.commit()
            conn.close()
            self._send_json({"ok": True})

        elif path.startswith("/api/alertas/") and path.endswith("/notificar"):
            alerta_id = int(path.split("/")[3])
            conn = get_db()
            conn.execute("UPDATE alertas SET notificado = 1 WHERE id = ?", (alerta_id,))
            conn.commit()
            conn.close()
            self._send_json({"ok": True})

        elif path == "/api/estudiantes":
            try:
                conn = get_db()
                conn.execute(
                    "INSERT INTO estudiantes (cedula, nombres, curso, representante, telefono) VALUES (?, ?, ?, ?, ?)",
                    (data["cedula"], data["nombres"], data["curso"], data["representante"], data["telefono"]),
                )
                conn.commit()
                conn.close()
                self._send_json({"ok": True})
            except sqlite3.IntegrityError:
                self._send_json({"ok": False, "mensaje": "La cédula ya está registrada"}, status=400)

        elif path == "/api/usuarios":
            try:
                conn = get_db()
                conn.execute(
                    "INSERT INTO usuarios (usuario, clave, nombre) VALUES (?, ?, ?)",
                    (data["usuario"].strip(), hash_password(data["clave"].strip()), data["nombre"].strip()),
                )
                conn.commit()
                conn.close()
                self._send_json({"ok": True})
            except sqlite3.IntegrityError:
                self._send_json({"ok": False, "mensaje": "El nombre de usuario ya existe"}, status=400)

        else:
            self.send_error(404)

    def do_PUT(self):
        if not self._get_session():
            self._send_json({"ok": False, "mensaje": "No autorizado"}, status=401)
            return

        path = urlparse(self.path).path
        if path.startswith("/api/estudiantes/"):
            est_id = int(path.split("/")[3])
            data = self._read_json()
            conn = get_db()
            conn.execute(
                """UPDATE estudiantes 
                   SET nombres = ?, curso = ?, representante = ?, telefono = ?, estado_hoy = ?
                   WHERE id = ?""",
                (data["nombres"], data["curso"], data["representante"], data["telefono"], data["estado_hoy"], est_id),
            )
            conn.commit()
            conn.close()
            self._send_json({"ok": True})
        else:
            self.send_error(404)

    def do_DELETE(self):
        if not self._get_session():
            self._send_json({"ok": False, "mensaje": "No autorizado"}, status=401)
            return

        path = urlparse(self.path).path
        if path.startswith("/api/usuarios/"):
            usr_id = int(path.split("/")[3])
            conn = get_db()
            conn.execute("DELETE FROM usuarios WHERE id = ? AND usuario != 'admin'", (usr_id,))
            conn.commit()
            conn.close()
            self._send_json({"ok": True})
        else:
            self.send_error(404)


if __name__ == "__main__":
    init_db()
    server = ThreadingHTTPServer(("127.0.0.1", 5000), RequestHandler)
    print("Servidor activo en http://127.0.0.1:5000 (Presiona Ctrl+C para detener)")
    server.serve_forever()