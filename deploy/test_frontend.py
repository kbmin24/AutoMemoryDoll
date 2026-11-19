"""Opt-in nginx startup check against the locally built frontend image."""

import os
from pathlib import Path
import subprocess
import unittest


class FrontendContainerTests(unittest.TestCase):
    def test_api_uploads_stream_with_bounded_temporary_storage(self):
        config = (Path(__file__).parent / "nginx.conf").read_text()
        api_location = config.split("location ~ ^/api(?:/|$) {", 1)[1].split("}", 1)[0]
        self.assertIn("proxy_request_buffering off;", api_location)
        self.assertIn("proxy_http_version 1.1;", api_location)
        self.assertIn("client_max_body_size 102m;", config)

    @unittest.skipUnless(
        os.environ.get("RUN_FRONTEND_INTEGRATION") == "1",
        "Set RUN_FRONTEND_INTEGRATION=1 after building the frontend image",
    )
    def test_nginx_initializes_with_read_only_root_and_only_tmp_writable(self):
        result = subprocess.run(
            [
                "docker", "run", "--rm", "--read-only", "--network=none",
                "--cap-drop=ALL", "--security-opt=no-new-privileges",
                "--cpus=0.25", "--memory=128m", "--memory-swap=128m",
                "--pids-limit=32",
                "--tmpfs", "/tmp:rw,nosuid,nodev,mode=1777,size=64m",
                "--entrypoint", "nginx",
                os.environ.get("FRONTEND_IMAGE", "automemorydoll-frontend:local"),
                "-t",
            ],
            capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
