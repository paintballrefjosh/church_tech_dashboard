from signage_agent import console


def test_the_message_is_centred_on_a_clear_screen():
    out = console.render("Updating the screen software", "Back in a moment", 33, 120)
    assert out.startswith("\x1b[0m\x1b[?25l\x1b[2J\x1b[H")  # reset, cursor hidden, cleared, top left
    lines = out.split("\n")
    assert len(lines) == 15 + 3  # centred vertically: the title on the middle row
    title = lines[15].replace("\x1b[1m", "").replace("\x1b[0m", "")
    assert title.strip() == "Updating the screen software"
    assert title.index("U") == (120 - len("Updating the screen software")) // 2


def test_no_console_is_not_an_error(tmp_path, monkeypatch):
    monkeypatch.setattr(console, "TTY", str(tmp_path / "tty1"))
    assert console.say(console.UPDATING) is False


def test_it_writes_to_the_console(tmp_path, monkeypatch):
    tty = tmp_path / "tty1"
    tty.write_text("")
    monkeypatch.setattr(console, "TTY", str(tty))
    monkeypatch.setattr(console, "FONT_DIR", str(tmp_path / "fonts"))
    assert console.say(console.RESTARTING) is True
    assert "Restarting" in tty.read_text()
