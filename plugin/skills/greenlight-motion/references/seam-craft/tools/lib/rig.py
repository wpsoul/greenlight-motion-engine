"""rig.py — evaluate a world-rig film (WORLD null + additive parents) and project to the screen. A starting point:
calibrate P and the axis signs per film (see ../../world-rig-films.md, "In the Video Editor").
Conventions (check them on your render): s = P / (P - Z_eff) with the editor's pinhole P = (H/2)/tan 14°
(pinhole(H); 2166 at 1080 tall), screen x = W/2 + X_eff*s, screen y = H/2 + Y_eff*s (translateY positive = down);
pan: x = panX*W/100, y = panY*H/100 (down), z = panZ. Assumes 30 fps and a 1920×1080 project (FPS, P and the
960/540/19.2/10.8 below): change them for another size."""
import math, sys, json
sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))
import easing  # noqa
FPS = 30.0


def pinhole(h=1080.0):
    """the editor's perspective distance for a frame h px tall: (h/2)/tan 14° (camera.md)"""
    return (h / 2.0) / math.tan(math.radians(14.0))


P = 2166.0                                   # pinhole(1080) = 2165.8


class Rig:
    def __init__(self, d):
        self.d = d; self.idx = {}
        for ch in d["channels"]:
            for it in ch["items"]: self.idx[it["id"]] = (ch, it)

    def it(self, i): return self.idx[i][1]

    @staticmethod
    def span(it):
        sp = it.get("speedPoints"); s = float(sp[0]["y"]) if sp else 1.0
        return (float(it["trimEnd"]) - float(it.get("trimStart") or 0)) / s

    def pos(self, it, f): return (f / FPS - float(it["freeStart"])) / self.span(it) * 100

    def val(self, i, tr, f, default=0.0):
        it = self.it(i); ks = (it.get("propertyKeyframes") or {}).get(tr)
        if ks: return easing.track(ks, self.pos(it, f))
        if tr in ("translateX", "translateY", "translateZ", "rotateY"): return default
        return float(it.get(tr, default) if it.get(tr) is not None else default)

    def parent(self, i): return ((self.it(i).get("keyframeParenting") or {}).get("parentItemId"))

    def eff(self, i, f):
        """summed translate along the additive chain (+ the item's pan), and the product of zooms"""
        X = Y = Z = 0.0; zoom = 1.0; x = i
        while x:
            it = self.it(x)
            X += self.val(x, "translateX", f) + float(it.get("panX") or 0) * 19.2
            Y += self.val(x, "translateY", f) + float(it.get("panY") or 0) * 10.8
            Z += self.val(x, "translateZ", f) + float(it.get("panZ") or 0)
            if it.get("zoom") is not None: zoom *= float(it["zoom"])
            x = self.parent(x)
        return X, Y, Z, zoom

    @staticmethod
    def proj(X, Y, Z):
        s = P / (P - Z)
        return 960 + X * s, 540 + Y * s, s
