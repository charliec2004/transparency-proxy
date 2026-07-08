#!/usr/bin/env python3
"""One-command demo launcher for the transparency proxy.

Usage:
    python3 demo.py            # prompts for your OpenAI API key (hidden input)
    OPENAI_API_KEY=sk-... python3 demo.py     # or take it from the environment

What it does:
    1. stops any leftover proxy / mock-upstream from rehearsal mode
    2. starts the proxy with the key (key lives only in the proxy process env)
    3. waits until the proxy is up, opens the inspector in your browser
    4. launches `codex --profile transparency` in this terminal
    5. shuts the proxy down when Codex exits

The key is never written to disk, never logged, and never passed as a
command-line argument (so it does not show up in `ps` or shell history).
"""

import getpass
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.request
import webbrowser

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
PROXY_URL = "http://127.0.0.1:8080"
PROXY_LOG = os.path.join(PROJECT_DIR, "proxy.log")


def get_key() -> str:
    key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not key:
        key = getpass.getpass("Paste your OpenAI API key (input hidden): ").strip()
    if not key.startswith("sk-") or len(key) < 20:
        sys.exit("That does not look like an OpenAI API key (should start with 'sk-').")
    return key


def stop_leftovers() -> None:
    # Only kill our own processes: match on this project's script paths.
    for pattern in (
        os.path.join(PROJECT_DIR, "server.js"),
        os.path.join(PROJECT_DIR, "test", "mock-upstream.js"),
        "node server.js",
        "node test/mock-upstream.js",
    ):
        subprocess.run(["pkill", "-f", pattern], capture_output=True)
    time.sleep(0.5)


def wait_for_proxy(timeout_s: float = 10.0) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f"{PROXY_URL}/inspect", timeout=1):
                return True
        except OSError:
            time.sleep(0.25)
    return False


def main() -> None:
    if not shutil.which("node"):
        sys.exit("node not found on PATH — install Node.js first.")
    key = get_key()

    stop_leftovers()

    env = dict(os.environ, OPENAI_API_KEY=key)
    log = open(PROXY_LOG, "w")
    proxy = subprocess.Popen(
        ["node", "server.js"],
        cwd=PROJECT_DIR,
        env=env,
        stdout=log,
        stderr=subprocess.STDOUT,
    )

    try:
        if not wait_for_proxy():
            proxy.terminate()
            sys.exit(f"Proxy did not come up — check {PROXY_LOG}")

        print(f"proxy running:  {PROXY_URL}/v1/responses")
        print(f"inspector:      {PROXY_URL}/  (opening in browser)")
        webbrowser.open(f"{PROXY_URL}/")

        if shutil.which("codex"):
            print("launching: codex --profile transparency")
            print("(type something small — 'say hi' — then watch the inspector)\n")
            subprocess.call(["codex", "--profile", "transparency"], env=env)
        else:
            print("\n'codex' not found on PATH. In another terminal run:")
            print("  OPENAI_API_KEY=<your key> codex --profile transparency")
            print("\nProxy stays up until you press Ctrl-C here.")
            signal.pause()
    except KeyboardInterrupt:
        pass
    finally:
        print("\nshutting down proxy...")
        proxy.terminate()
        try:
            proxy.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proxy.kill()
        log.close()


if __name__ == "__main__":
    main()
