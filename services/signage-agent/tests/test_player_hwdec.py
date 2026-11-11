from signage_agent import player


def test_hardware_decoding_is_chosen_by_model():
    # auto-safe never picks the V4L2 codec, so a Pi 3 or 4 decoded H.264 on its CPU (choppy 1080p, 2026-11-11).
    assert player.default_hwdec("Raspberry Pi 3 Model B Plus Rev 1.4") == "v4l2m2m-copy"
    assert player.default_hwdec("Raspberry Pi 4 Model B Rev 1.5") == "v4l2m2m-copy"
    assert player.default_hwdec("Raspberry Pi 5 Model B Rev 1.0") == "auto-safe"
    assert player.default_hwdec("") == "auto-safe"
    assert "--hwdec=v4l2m2m-copy" in player.mpv_args("landscape", "v4l2m2m-copy")


def test_frames_reach_the_screen_at_once():
    # A picture is drawn once; with mpv's default queue of 3 the TV kept showing the picture before (2026-11-11).
    assert "--swapchain-depth=1" in player.mpv_args("landscape")
