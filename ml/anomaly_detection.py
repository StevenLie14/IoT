"""Detect sensor anomalies in the IoT Project dataset.

Two methods:
  1. Rule checks  - out-of-range values, a sensor stuck at the same value, sudden jumps.
  2. Isolation Forest - unsupervised model that flags readings unlike the rest.

These match faults seen while building the prototype: turbidity stuck near 0 V when a probe
wire was loose, unstable readings without a common ground, and pulse noise from the pump.

Usage:
    python anomaly_detection.py --csv iot_project_dataset.csv
Output: results/anomalies.csv, results/anomalies.png, printed summary
"""
import argparse
import os
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd
from sklearn.ensemble import IsolationForest

RANGES = {"tds": (0, 2000), "turb_v": (0.05, 4.8), "t_tank": (5, 40)}   # physically plausible values
JUMP = {"tds": 150, "turb_v": 0.8, "t_tank": 2.0}                       # max change between 2 s readings
STUCK_ROWS = 60                                                         # 2 minutes at 2 s


def main():
    """Runs the rule checks and the Isolation Forest, then saves the flagged rows and a plot."""
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--csv", required=True)
    ap.add_argument("--contamination", type=float, default=0.02, help="expected share of anomalies for Isolation Forest")
    ap.add_argument("--include-sim", action="store_true")
    ap.add_argument("--out", default="results")
    a = ap.parse_args()

    df = pd.read_csv(a.csv)
    if not a.include_sim and "source" in df.columns:
        df = df[df["source"] == "device"]
    feats = [c for c in RANGES if c in df.columns]
    df["time"] = pd.to_datetime(df["timestamp_wib"])
    df = df.dropna(subset=feats).sort_values("time").reset_index(drop=True)
    if len(df) < 50:
        sys.exit("Need at least 50 rows.")
    pumps = (df.get("drain", 0).fillna(0) + df.get("fill", 0).fillna(0)) > 0

    flags = pd.DataFrame(index=df.index)
    for c in feats:
        lo, hi = RANGES[c]
        flags[f"{c}_out_of_range"] = (df[c] < lo) | (df[c] > hi)
        flags[f"{c}_jump"] = (df[c].diff().abs() > JUMP[c]) & ~pumps
        flags[f"{c}_stuck"] = df[c].rolling(STUCK_ROWS).std().fillna(1) == 0

    # Isolation Forest on values and their change, pumps-off rows only
    X = df[feats].copy()
    for c in feats:
        X[f"d_{c}"] = df[c].diff().fillna(0)
    iso = IsolationForest(contamination=a.contamination, random_state=42)
    calm = ~pumps
    iso.fit(X[calm])
    flags["isolation_forest"] = False
    flags.loc[calm, "isolation_forest"] = iso.predict(X[calm]) == -1

    df["anomaly"] = flags.any(axis=1)
    df["reasons"] = flags.apply(lambda r: ", ".join(r.index[r.values]), axis=1)

    os.makedirs(a.out, exist_ok=True)
    out = df[df["anomaly"]]
    keep = [c for c in ["timestamp_wib"] + feats + ["drain", "fill", "state", "reasons"] if c in df.columns]
    out[keep].to_csv(os.path.join(a.out, "anomalies.csv"), index=False)

    print(f"Rows checked: {len(df)}, flagged: {len(out)} ({len(out) / len(df):.1%})")
    print(flags.sum()[flags.sum() > 0].to_string())

    fig, axes = plt.subplots(len(feats), 1, figsize=(10, 2.4 * len(feats)), sharex=True)
    axes = axes if len(feats) > 1 else [axes]
    x = df["time"]
    for ax, c in zip(axes, feats):
        ax.plot(x, df[c], lw=0.8, color="#2563eb")
        ax.scatter(x[df["anomaly"]], df.loc[df["anomaly"], c], color="#d64545", s=12, zorder=3, label="anomaly")
        ax.set_ylabel(c)
    axes[0].legend(loc="upper right"); axes[0].set_title("IoT Project sensor anomalies")
    axes[-1].set_xlabel("time (WIB)")
    fig.tight_layout(); fig.savefig(os.path.join(a.out, "anomalies.png"), dpi=150)
    print(f"Saved {a.out}/anomalies.csv and {a.out}/anomalies.png")


if __name__ == "__main__":
    main()
