"""Live prediction: read the newest reading from the IoT Project server every 5 s, classify the
water condition with the trained model, and send the result back so the dashboard shows it
in the "AI prediction" card.

Usage:
    python predict_live.py                       # server at http://localhost:3000
    python predict_live.py --server http://localhost:3000 --model models/water_condition_model.joblib
    python predict_live.py --server https://iot.stevenlie.site --user admin --password secret

When the server has DASHBOARD_PASSWORD set, pass --user/--password (or set the
DASHBOARD_USER / DASHBOARD_PASSWORD environment variables).
"""
import argparse
import os
import time

import joblib
import pandas as pd
import requests


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", default="http://localhost:3000")
    ap.add_argument("--model", default="models/water_condition_model.joblib")
    ap.add_argument("--interval", type=float, default=5.0)
    ap.add_argument("--once", action="store_true", help="predict one reading and exit")
    ap.add_argument("--user", default=os.environ.get("DASHBOARD_USER", "admin"))
    ap.add_argument("--password", default=os.environ.get("DASHBOARD_PASSWORD", ""))
    a = ap.parse_args()
    auth = (a.user, a.password) if a.password else None

    bundle = joblib.load(a.model)
    model, feats = bundle["model"], bundle["features"]
    print(f"Loaded {bundle['name']} using features {feats}")
    last_id = None
    while True:
        try:
            r = requests.get(f"{a.server}/api/latest", timeout=5, auth=auth).json().get("reading")
            if r and r["id"] != last_id and all(r.get(f) is not None for f in feats):
                last_id = r["id"]
                X = pd.DataFrame([[r[f] for f in feats]], columns=feats)
                label = model.predict(X)[0]
                conf = float(model.predict_proba(X).max()) if hasattr(model, "predict_proba") else None
                requests.post(f"{a.server}/api/ml", json={"prediction": label, "confidence": conf, "model": bundle["name"],
                                                         "reading_id": r["id"], "features": {f: r[f] for f in feats}}, timeout=5, auth=auth)
                print(f"#{r['id']}  {', '.join(f'{f}={r[f]}' for f in feats)}  ->  {label}" + (f" ({conf:.0%})" if conf is not None else ""))
                if a.once:
                    break
        except requests.RequestException as e:
            print("Server not reachable:", e)
        time.sleep(a.interval)


if __name__ == "__main__":
    main()
