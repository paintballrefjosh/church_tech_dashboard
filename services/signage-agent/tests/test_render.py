import pytest

from signage_agent import render

KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDrk317OG12pp6m2uiktuZld2ifcvU4kftYmS7aduYHB church-dashboard-signage-g1"


def config(**kw):
    c = {
        "v": 1,
        "loginAccount": "dedicated",
        "setupUser": "pi",
        "lockSetupPassword": True,
        "passwordLogin": False,
        "rootLogin": False,
        "allowOnlyLogin": True,
        "onlyFrom": ["10.1.0.5/32", "10.1.0.6/32"],
        "restrictKey": True,
        "firewall": False,
        "readOnlyRoot": True,
        "osUpdateWindow": "Tue 02:00-04:00",
        "ntpServer": "10.1.0.1",
        "timezone": "Europe/London",
        "hostname": "foyer-tv",
        "authorizedKeys": [KEY],
    }
    c.update(kw)
    return c


def test_check_config_accepts_the_dashboards_shape():
    assert render.check_config(config())["hostname"] == "foyer-tv"


@pytest.mark.parametrize(
    "bad",
    [
        {"v": 2},
        {"loginAccount": "root"},
        {"setupUser": "Pi; rm -rf /"},
        {"onlyFrom": ["not a cidr"]},
        {"authorizedKeys": ["ssh-ed25519 AAAA\nPermitRootLogin yes"]},
        {"authorizedKeys": []},
        {"hostname": "Bad_Host"},
        {"ntpServer": "pool.ntp.org\nPermitRootLogin yes"},
        {"timezone": "../../etc/passwd"},
        {"passwordLogin": "no"},
    ],
)
def test_check_config_refuses(bad):
    with pytest.raises(render.ConfigError):
        render.check_config(config(**bad))


def test_sshd_dropin_locks_down():
    text = render.sshd_dropin(config())
    assert "PasswordAuthentication no" in text
    assert "KbdInteractiveAuthentication no" in text
    assert "PermitRootLogin no" in text
    assert "AllowUsers signage" in text
    assert "VersionAddendum church-signage" in text
    assert "Match Address *,!10.1.0.5/32,!10.1.0.6/32\n    DenyUsers *" in text


def test_sshd_dropin_setup_account_and_open():
    text = render.sshd_dropin(config(loginAccount="setup", passwordLogin=True, onlyFrom=[], allowOnlyLogin=True))
    assert "AllowUsers pi" in text
    assert "PasswordAuthentication yes" in text
    assert "Match" not in text


def test_authorized_keys_options():
    line = render.authorized_keys(config())
    assert line == f'from="10.1.0.5/32,10.1.0.6/32",command="/usr/local/bin/signage-ctl",restrict {KEY}\n'
    assert render.authorized_keys(config(onlyFrom=[], restrictKey=False)) == KEY + "\n"


def test_sudoers_names_only_signage_ctl():
    assert render.sudoers("signage").strip().endswith("signage ALL=(root) NOPASSWD: /usr/local/bin/signage-ctl")
    with pytest.raises(render.ConfigError):
        render.sudoers("x ALL=(ALL)")


def test_nft_rules():
    rules = render.nft_rules(config(firewall=True))
    assert "policy drop" in rules
    assert "ip saddr { 10.1.0.5/32, 10.1.0.6/32 } tcp dport 22 accept" in rules
    assert "tcp dport 22 accept" in render.nft_rules(config(onlyFrom=[]))


def test_sshd_drift():
    eff = render.parse_sshd_t("passwordauthentication no\nkbdinteractiveauthentication no\npermitrootlogin no\nallowusers signage\n")
    assert render.sshd_drift(config(), eff) == []
    eff["passwordauthentication"] = "yes"
    assert render.sshd_drift(config(), eff) == ["passwordauthentication is yes, wanted no"]
