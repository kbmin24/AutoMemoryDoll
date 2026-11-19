"""Check deployment wiring and execute its permission initializer without Docker."""

import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent


class ComposeDeploymentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.environment = dict(
            os.environ,
            SERVICE_UID="1000",
            SERVICE_GID="1000",
            DOCKER_GID="999",
            POSTGRES_PASSWORD="a" * 64,
            JWT_SECRET="b" * 96,
            OWNER_USERNAME="owner",
            OWNER_PASSWORD="initial-owner-password",
            COMPILER_CPUS="1",
            COMPILER_MEMORY_MB="512",
            COMPILER_PIDS="64",
            COMPILER_WALL_TIME_MS="60000",
            WORKER_STOP_GRACE_PERIOD="90s",
        )
        cls.command = [
            "docker", "compose", "--env-file", "app.env.example",
            "-f", "compose.app.yaml", "config", "--format", "json",
        ]
        result = subprocess.run(cls.command, cwd=ROOT, env=cls.environment,
                                check=True, capture_output=True, text=True)
        cls.config = json.loads(result.stdout)

    def test_database_queue_and_owner_are_startup_dependencies(self):
        services = self.config["services"]
        for name in ["api", "worker"]:
            dependencies = services[name]["depends_on"]
            self.assertEqual(dependencies["postgres"]["condition"], "service_healthy")
            self.assertEqual(dependencies["redis"]["condition"], "service_healthy")
            self.assertEqual(dependencies["bootstrap-owner"]["condition"],
                             "service_completed_successfully")
        self.assertEqual(services["bootstrap-owner"]["depends_on"]["migrate"]["condition"],
                         "service_completed_successfully")
        self.assertEqual(services["migrate"]["depends_on"]["postgres"]["condition"],
                         "service_healthy")
        self.assertEqual(services["compiler-image"]["runtime"], "runsc")
        self.assertEqual(services["worker"]["depends_on"]["compiler-image"]["condition"],
                         "service_completed_successfully")

    def test_database_and_queue_are_private_and_persistent(self):
        for name, volume in [("postgres", "postgres-data"), ("redis", "redis-data")]:
            service = self.config["services"][name]
            self.assertFalse(service.get("ports"))
            self.assertIn(volume, self.config["volumes"])
            self.assertTrue(any(item["source"] == volume for item in service["volumes"]))

    def test_docker_logs_are_rotated_for_every_service(self):
        for name, service in self.config["services"].items():
            with self.subTest(service=name):
                self.assertEqual(service.get("logging"), {
                    "driver": "json-file",
                    "options": {"max-size": "10m", "max-file": "3"},
                })

    def test_approved_resource_limits_cover_every_service(self):
        profiles = {
            "api": (0.5, 256, 64, 32),
            "worker": (0.5, 256, 64, 32),
            "postgres": (0.75, 384, 128, 32),
            "redis": (0.25, 128, 32, None),
            "frontend": (0.25, 128, 32, 64),
            "init-storage": (0.5, 256, 64, None),
            "migrate": (0.5, 256, 64, 32),
            "bootstrap-owner": (0.5, 256, 64, 32),
            "compiler-image": (1, 512, 64, None),
        }
        self.assertEqual(set(self.config["services"]), set(profiles))
        for name, (cpus, memory_mb, pids, tmp_mb) in profiles.items():
            with self.subTest(service=name):
                service = self.config["services"][name]
                self.assertEqual(float(service["cpus"]), cpus)
                self.assertEqual(int(service["mem_limit"]), memory_mb * 1024**2)
                self.assertEqual(service["memswap_limit"], service["mem_limit"])
                self.assertEqual(service["pids_limit"], pids)
                if tmp_mb is not None:
                    self.assertIn(f"/tmp:rw,nosuid,nodev,mode=1777,size={tmp_mb}m",
                                  service["tmpfs"])
                for mount in service.get("tmpfs", []):
                    self.assertIn("size=", mount)

    def test_resource_limits_are_required_and_overridable(self):
        variables = [
            f"{service}_{suffix}"
            for service in ["API", "WORKER", "POSTGRES", "REDIS", "FRONTEND"]
            for suffix in ["CPUS", "MEMORY_MB", "PIDS", "TMP_MB"]
            if not (service == "REDIS" and suffix == "TMP_MB")
        ]
        for variable in variables:
            with self.subTest(variable=variable):
                result = subprocess.run(
                    self.command, cwd=ROOT,
                    env={**self.environment, variable: ""},
                    capture_output=True, text=True,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(variable, result.stderr)
        result = subprocess.run(
            self.command, cwd=ROOT,
            env={**self.environment, "WORKER_CPUS": "0.75",
                 "WORKER_MEMORY_MB": "320", "WORKER_PIDS": "96",
                 "WORKER_TMP_MB": "48"},
            check=True, capture_output=True, text=True,
        )
        services = json.loads(result.stdout)["services"]
        worker = services["worker"]
        self.assertEqual(float(worker["cpus"]), 0.75)
        self.assertEqual(int(worker["mem_limit"]), 320 * 1024**2)
        self.assertEqual(worker["memswap_limit"], worker["mem_limit"])
        self.assertEqual(worker["pids_limit"], 96)
        self.assertIn("/tmp:rw,nosuid,nodev,mode=1777,size=48m", worker["tmpfs"])
        self.assertEqual(int(services["api"]["mem_limit"]), 256 * 1024**2)

    def test_worker_alone_has_socket_and_bootstrap_alone_has_owner_password(self):
        for name, service in self.config["services"].items():
            mounts = [volume["target"] for volume in service.get("volumes", [])]
            self.assertEqual("/var/run/docker.sock" in mounts, name == "worker")
            self.assertEqual("OWNER_PASSWORD" in service.get("environment", {}),
                             name == "bootstrap-owner")
        for name in ["api", "worker", "bootstrap-owner", "migrate"]:
            self.assertEqual(self.config["services"][name]["user"], "1000:1000")
        storage = self.config["services"]["worker"]["environment"]["STORAGE_ROOT"]
        self.assertTrue(any(volume["source"] == volume["target"] == storage
                            for volume in self.config["services"]["worker"]["volumes"]))

    def test_missing_database_secret_is_rejected(self):
        result = subprocess.run(self.command, cwd=ROOT,
                                env={**self.environment, "POSTGRES_PASSWORD": ""},
                                capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("POSTGRES_PASSWORD", result.stderr)

    def test_http_setting_changes_api_only(self):
        result = subprocess.run(
            self.command, cwd=ROOT,
            env={**self.environment, "API_NODE_ENV": "development"},
            check=True, capture_output=True, text=True,
        )
        services = json.loads(result.stdout)["services"]
        self.assertEqual(services["api"]["environment"]["NODE_ENV"], "development")
        self.assertEqual(services["worker"]["environment"]["NODE_ENV"], "production")

    def run_initializer(self, data, logs, uid=None):
        environment = dict(os.environ, STORAGE_ROOT=str(data), LOG_DIR=str(logs),
                           SERVICE_UID=str((os.getuid() or 65532) if uid is None else uid),
                           SERVICE_GID=str(os.getgid() or 65532))
        command = self.config["services"]["init-storage"]["command"]
        self.assertEqual(command, ["sh", "/app/deploy/init-storage.sh"])
        return subprocess.run(["sh", ROOT / "deploy/init-storage.sh"],
                              env=environment, capture_output=True, text=True)

    def test_initializer_sets_private_permissions_without_removing_documents(self):
        with tempfile.TemporaryDirectory() as directory:
            data, logs = Path(directory) / "data", Path(directory) / "logs"
            data.mkdir(mode=0o755)
            logs.mkdir(mode=0o755)
            self.assertEqual(self.run_initializer(data, logs).returncode, 0)
            self.assertEqual(stat.S_IMODE(data.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(logs.stat().st_mode), 0o700)
            document = data / "keep.pdf"
            document.write_bytes(b"existing document")
            self.assertEqual(self.run_initializer(data, logs).returncode, 0)
            self.assertEqual(document.read_bytes(), b"existing document")
            data.chmod(0o755)
            self.assertNotEqual(self.run_initializer(data, logs).returncode, 0)
            self.assertEqual(stat.S_IMODE(data.stat().st_mode), 0o755)
            self.assertEqual(document.read_bytes(), b"existing document")

    def test_initializer_rejects_root_and_symlink_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            data, logs = Path(directory) / "data", Path(directory) / "logs"
            data.mkdir(mode=0o755)
            logs.symlink_to(data)
            self.assertNotEqual(self.run_initializer(data, logs, uid=0).returncode, 0)
            self.assertEqual(stat.S_IMODE(data.stat().st_mode), 0o755)
            self.assertNotEqual(self.run_initializer(data, logs).returncode, 0)


if __name__ == "__main__":
    unittest.main()
