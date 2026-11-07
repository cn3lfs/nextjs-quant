"""Regenerate a synthetic golden from pinned Qlib expressions and pandas/numpy.

Run manually from the repo root; never opens application data or a database.
The upstream module only declares data-loader classes. Its Qlib base is stubbed;
expressions are interpreted through an AST allowlist, never eval/exec.
"""
import ast
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import sys
import types

import numpy as np
import pandas as pd

root = Path(__file__).resolve().parents[2]
source = root / "docs/data-sources/public-factors/qlib-v0.9.7/loader.py"
stub = types.ModuleType("qlib.data.dataset.loader")
stub.QlibDataLoader = object
sys.modules["qlib.data.dataset.loader"] = stub
spec = importlib.util.spec_from_file_location("pinned_qlib_loader", source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
expressions, names = module.Alpha158DL.get_feature_config()
bars = []
for i in range(80):
    close = 20 + i * .03 + math.sin(i * 1.13)
    opened = close + math.cos(i * .7) * .4
    bars.append(dict(date=f"bar-{i}", open=opened, close=close,
                     high=max(opened, close) + .7, low=min(opened, close) - .9,
                     volume=1000 + (i * 97) % 593, amount=0))
frame = pd.DataFrame(bars)


def regression(values, result):
    x = np.arange(len(values))
    slope, intercept = np.polyfit(x, values, 1)
    if result == "slope":
        return slope
    if result == "residual":
        return values[-1] - (intercept + slope * x[-1])
    return np.corrcoef(x, values)[0, 1] ** 2


functions = {
    "Ref": lambda x, n: x.shift(n),
    "Mean": lambda x, n: x.rolling(n, min_periods=n).mean(),
    "Std": lambda x, n: x.rolling(n, min_periods=n).std(ddof=1),
    "Sum": lambda x, n: x.rolling(n, min_periods=n).sum(),
    "Max": lambda x, n: x.rolling(n, min_periods=n).max(),
    "Min": lambda x, n: x.rolling(n, min_periods=n).min(),
    "Quantile": lambda x, n, q: x.rolling(n, min_periods=n).quantile(q),
    "Rank": lambda x, n: x.rolling(n, min_periods=n).rank(pct=True),
    "IdxMax": lambda x, n: x.rolling(n, min_periods=n).apply(lambda w: np.argmax(w) + 1, raw=True),
    "IdxMin": lambda x, n: x.rolling(n, min_periods=n).apply(lambda w: np.argmin(w) + 1, raw=True),
    "Slope": lambda x, n: x.rolling(n, min_periods=n).apply(lambda w: regression(w, "slope"), raw=True),
    "Rsquare": lambda x, n: x.rolling(n, min_periods=n).apply(lambda w: regression(w, "r2"), raw=True),
    "Resi": lambda x, n: x.rolling(n, min_periods=n).apply(lambda w: regression(w, "residual"), raw=True),
    "Corr": lambda x, y, n: x.rolling(n, min_periods=n).corr(y),
    "Greater": np.maximum, "Less": np.minimum, "Log": np.log, "Abs": np.abs,
}


def interpret(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return node.value
    if isinstance(node, ast.Name) and node.id in frame:
        return frame[node.id]
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
        return -interpret(node.operand)
    if isinstance(node, ast.BinOp):
        a, b = interpret(node.left), interpret(node.right)
        if isinstance(node.op, ast.Add): return a + b
        if isinstance(node.op, ast.Sub): return a - b
        if isinstance(node.op, ast.Mult): return a * b
        if isinstance(node.op, ast.Div): return a / b
    if isinstance(node, ast.Compare) and len(node.ops) == 1:
        a, b = interpret(node.left), interpret(node.comparators[0])
        result = (a > b if isinstance(node.ops[0], ast.Gt) else a < b).astype(float)
        return result.mask(pd.isna(a) | pd.isna(b))
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in functions:
        return functions[node.func.id](*(interpret(arg) for arg in node.args))
    raise ValueError(ast.dump(node))


indices = [60, 71, 79]
expected = {}
for expression, name in zip(expressions, names):
    if name == "VWAP0":
        continue
    values = interpret(ast.parse(expression.replace("$", ""), mode="eval").body)
    expected[name] = [float(values.iloc[i]) if math.isfinite(values.iloc[i]) else None for i in indices]
result = {
    "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
    "reference": "Qlib v0.9.7 feature expressions, interpreted using pandas/numpy; complete windows",
    "pandas": pd.__version__, "numpy": np.__version__, "bars": bars,
    "indices": indices, "expected": expected,
}
target = root / "tests/fixtures/factors/qlib-alpha158-golden.json"
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n", encoding="utf-8")
print(f"Generated {len(expected)} independent reference features")
