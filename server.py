"""Serves the AlertMap frontend and a small JSON API for community incident
reports, backed by SQLite so a report from any device shows up on every
other device that polls GET /api/reports.
"""
import os
import sqlite3
from datetime import datetime, timezone

from flask import Flask, g, jsonify, request, send_from_directory

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "reports.db")

# Severity -> colour is decided client-side; the server just validates the
# category is one of the three the UI knows how to render.
REPORT_CATEGORIES = {"burglary", "assault", "disturbance"}

# Only these frontend assets are servable; everything else in BASE_DIR
# (server.py, reports.db, pyproject.toml, ...) stays off-limits over HTTP.
FRONTEND_FILES = {"index.html", "app.js", "config.js", "mock-maps.js", "synthetic-data.js"}

app = Flask(__name__)


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS reports (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                lat REAL NOT NULL,
                lng REAL NOT NULL,
                category TEXT NOT NULL,
                description TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
        conn.commit()
    finally:
        conn.close()


@app.route("/api/reports", methods=["GET"])
def list_reports():
    rows = get_db().execute("SELECT * FROM reports ORDER BY id DESC").fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/reports", methods=["POST"])
def create_report():
    data = request.get_json(silent=True) or {}

    try:
        lat = float(data.get("lat"))
        lng = float(data.get("lng"))
    except (TypeError, ValueError):
        return jsonify({"error": "lat/lng must be numbers"}), 400
    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        return jsonify({"error": "lat/lng out of range"}), 400

    category = str(data.get("category", "")).strip().lower()
    if category not in REPORT_CATEGORIES:
        return jsonify({"error": f"category must be one of {sorted(REPORT_CATEGORIES)}"}), 400

    description = str(data.get("description", "")).strip()[:500]
    if not description:
        return jsonify({"error": "description is required"}), 400

    created_at = datetime.now(timezone.utc).isoformat()
    db = get_db()
    cur = db.execute(
        "INSERT INTO reports (lat, lng, category, description, created_at) VALUES (?, ?, ?, ?, ?)",
        (lat, lng, category, description, created_at),
    )
    db.commit()
    return jsonify({
        "id": cur.lastrowid,
        "lat": lat,
        "lng": lng,
        "category": category,
        "description": description,
        "created_at": created_at,
    }), 201


@app.route("/")
def index():
    return send_from_directory(BASE_DIR, "index.html")


@app.route("/<path:filename>")
def frontend_file(filename):
    if filename not in FRONTEND_FILES:
        return ("Not found", 404)
    return send_from_directory(BASE_DIR, filename)


if __name__ == "__main__":
    init_db()
    app.run(host="0.0.0.0", port=8000, debug=True)
