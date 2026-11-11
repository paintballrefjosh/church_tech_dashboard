import json
import os
import socket
import sys
import tempfile
import threading

ROOT = tempfile.mkdtemp(prefix="signage-root-")
os.environ["SIGNAGE_ROOT"] = ROOT
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from signage_agent import player


class FakeMpv:
    """Answers each command with a success; counts connections. Like mpv it forgets overlays when their connection closes."""

    def __init__(self, path: str) -> None:
        self.commands: list = []
        self.connections = 0
        self.overlays_alive = 0
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.bind(path)
        self.sock.listen(5)
        threading.Thread(target=self.serve, daemon=True).start()

    def serve(self) -> None:
        while True:
            c, _ = self.sock.accept()
            self.connections += 1
            threading.Thread(target=self.talk, args=(c,), daemon=True).start()

    def talk(self, c: socket.socket) -> None:
        mine = 0
        buf = b""
        try:
            while True:
                chunk = c.recv(4096)
                if not chunk:
                    break
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    req = json.loads(line)
                    cmd = req["command"]
                    self.commands.append(cmd)
                    if isinstance(cmd, dict) and cmd.get("name") == "osd-overlay":
                        mine += 1
                        self.overlays_alive += 1
                    c.sendall(b'{"event":"idle"}\n' + json.dumps({"data": None, "request_id": req["request_id"], "error": "success"}).encode() + b"\n")
        finally:
            self.overlays_alive -= mine
            c.close()


def test_overlays_live_on_one_connection_that_stays_open(tmp_path):
    player.SOCK = str(tmp_path / "mpv.sock")
    fake = FakeMpv(player.SOCK)
    m = player.Mpv()
    m.overlay("{\\an5}123")
    m.command("set_property", "loop-file", "no")
    m.overlay("{\\an5}456")
    m.overlay(None)
    assert fake.connections == 1
    m.overlay("{\\an5}789")
    assert fake.overlays_alive >= 1  # still held by the open connection
    m.stop()



def test_pictures_get_a_one_frame_queue_and_video_the_default(tmp_path):
    player.SOCK = str(tmp_path / "mpv3.sock")
    fake = FakeMpv(player.SOCK)
    m = player.Mpv()
    m.show("/m/a.jpg", loop=False)
    m.show("/m/v.mp4", loop=True)
    depths = [c[2] for c in fake.commands if isinstance(c, list) and c[:2] == ["set_property", "swapchain-depth"]]
    assert depths == [1, player.VIDEO_SWAPCHAIN]
    m.stop()
