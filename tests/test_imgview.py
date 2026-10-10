"""Tests for bin/imgview's pure parts. Run: python3 -m unittest discover -s tests"""
import importlib.machinery
import importlib.util
import io
import json
import os
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
IMGVIEW = os.path.join(HERE, "..", "bin", "imgview")

sys.argv = ["imgview"]  # the module reads its arguments at import
loader = importlib.machinery.SourceFileLoader("imgview", IMGVIEW)
spec = importlib.util.spec_from_loader("imgview", loader)
iv = importlib.util.module_from_spec(spec)
loader.exec_module(iv)

from PIL import Image  # noqa: E402  (imgview already required it)


class Text(unittest.TestCase):
    def test_trunc_keeps_both_ends(self):
        self.assertEqual(iv.trunc("a-very-long-name.png", 11), "a-ver…e.png")
        self.assertEqual(iv.trunc("short.png", 20), "short.png")
        self.assertEqual(iv.trunc("ending is cut", 8, middle=False), "ending …")

    def test_ago_and_sizes(self):
        now = time.time()
        self.assertEqual(iv.ago(now), "just now")
        self.assertEqual(iv.ago(now - 125), "2m ago")
        self.assertEqual(iv.ago(now - 3 * 86400), "3d ago")
        self.assertEqual(iv.human_size(512), "512 B")
        self.assertEqual(iv.human_size(2048), "2.0 KB")


class Log(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.a = os.path.join(self.dir, "a.png")
        self.b = os.path.join(self.dir, "b.png")
        for p in (self.a, self.b):
            Image.new("RGB", (8, 4), "red").save(p)
        lines = [
            {"kind": "file", "path": self.a, "time": 1000, "sessionId": "s1", "tool": "Bash", "via": "bash"},
            {"kind": "file", "path": self.b, "time": 2000, "sessionId": "s2", "tool": "Write", "via": "write"},
            {"kind": "file", "path": self.a, "time": 3000, "sessionId": "s1", "tool": "Read", "via": "read"},
            {"kind": "file", "path": os.path.join(self.dir, "gone.png"), "time": 4000, "sessionId": "s1"},
        ]
        iv.LOG = os.path.join(self.dir, "log.jsonl")
        with open(iv.LOG, "w") as f:
            f.write("\n".join(json.dumps(x) for x in lines) + "\nnot json\n")
        iv.SESSION = "s1"

    def test_one_session_newest_line_per_file_missing_dropped(self):
        items = iv.scan_log(all_sessions=False)
        self.assertEqual([i.path for i in items], [self.a])
        self.assertEqual(items[0].meta["via"], "read")

    def test_all_sessions_oldest_first(self):
        self.assertEqual([i.path for i in iv.scan_log(all_sessions=True)], [self.b, self.a])


class Pictures(unittest.TestCase):
    def test_fit_and_round(self):
        path = os.path.join(tempfile.mkdtemp(), "wide.png")
        Image.new("RGB", (400, 200), "blue").save(path)
        plain = iv.picture(path, 100, 100)
        self.assertEqual(plain.size, (100, 50))
        rounded = iv.picture(path, 100, 100, radius=10)
        import base64
        import io

        im = Image.open(io.BytesIO(base64.b64decode(rounded.data)))
        self.assertEqual(im.getpixel((0, 0))[3], 0)        # corner cut away
        self.assertEqual(im.getpixel((50, 25))[3], 255)    # middle intact
        self.assertNotEqual(plain.id, rounded.id)


class TerminalMemory(unittest.TestCase):
    """The kept-picture path (IMGVIEW_SIMPLE=0)."""

    def setUp(self):
        iv._sent.clear()
        iv.out = io.StringIO()

    def test_budget_frees_least_recently_placed(self):
        iv.SENT_BUDGET = 3 * 100 * 100 * 4           # room for three 100x100 pictures
        pics = [iv.Pic("AAAA", (100, 100)) for _ in range(4)]
        for pic in pics[:3]:
            iv.place(pic)
        iv.place(pics[0])                             # used again: now the most recent
        iv.place(pics[3])                             # needs room: pics[1] goes
        self.assertFalse(pics[1].sent)
        self.assertTrue(all(p.sent for p in (pics[0], pics[2], pics[3])))
        self.assertIn(f"a=d,d=I,i={pics[1].id}", iv.out.getvalue())

    def test_deleted_picture_is_sent_again(self):
        iv.SENT_BUDGET = 150 * 1024 * 1024
        pic = iv.Pic("AAAA", (10, 10))
        iv.place(pic)
        v = iv.Viewer.__new__(iv.Viewer)
        v.dirty, v.quitting, v.help = False, False, False
        v.key = lambda k: True
        v.handle(f"\x1b_Gi={pic.id};ENOENT:no such image\x1b\\")
        self.assertFalse(pic.sent)
        self.assertTrue(v.dirty)


if __name__ == "__main__":
    unittest.main()
