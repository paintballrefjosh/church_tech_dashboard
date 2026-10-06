#!/usr/bin/env python3
"""Drives ./install.sh in a real pseudo-terminal and corrects a typo with BOTH codes terminals send for
Backspace (^H and DEL). A plain shell `read` stores the erase key as text (the literal ^H); readline edits.
Usage: pty-edit.py <directory containing install.sh, .env.example and scripts/>. Exit 0 = the port came out right."""
import os, pty, re, select, sys, time

d = sys.argv[1]
os.chdir(d)
pid, fd = pty.fork()
if pid == 0:
    os.environ["NO_COLOR"] = "1"
    os.environ["TERM"] = "xterm"
    os.execv("./install.sh", ["./install.sh", "--dry-run"])

buf = b""


def read_until(pattern, timeout=15):
    global buf
    end = time.time() + timeout
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                return False
            if not chunk:
                return False
            buf += chunk
            if re.search(pattern, buf.decode(errors="replace")):
                return True
    return False


def step(pattern, keys):
    global buf
    assert read_until(pattern), f"timeout waiting for {pattern!r}; got {buf.decode(errors='replace')[-300:]!r}"
    buf = b""
    os.write(fd, keys)


step(r"Choose a number", b"1\r")  # one server
step(r"Choose a number", b"1\r")  # bundled database
step(r"Choose a number", b"1\r")  # bundled file storage
# the port: "8x", ^H, "12", "9", DEL, "5"  ->  8125
step(r"Port to serve", b"8x\x08" b"12" b"9\x7f" b"5\r")
step(r"load balancer or reverse proxy", b"\r")
step(r"Choose a number", b"2\r")
step(r"restoring a backup", b"\r")
step(r"Write the configuration", b"\r")
read_until(r"Dry run finished", 10)
try:
    os.waitpid(pid, 0)
except Exception:
    pass
env = open(os.path.join(d, ".env")).read()
line = [l for l in env.splitlines() if l.startswith("EXTERNAL_PORT=")][0]
print(line)
sys.exit(0 if line == "EXTERNAL_PORT=8125" and "\x08" not in env else 1)
