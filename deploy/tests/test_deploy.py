import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("fund_deploy", Path(__file__).parents[1] / "deploy.py")
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)

OLD = "ghcr.io/bobozh/fund-backend@sha256:" + "1" * 64
NEW = "ghcr.io/bobozh/fund-backend@sha256:" + "2" * 64
CONFIG = f"""services:
  backend:
    image: {OLD}
    network_mode: host
    env_file:
      - /opt/fund/env/backend.env
    volumes:
      - /opt/fund/data/backend/uploads:/app/uploads
"""


class FakeDeployment(deploy.Deployment):
    """Model Docker state changes, including partial updates and failed recovery."""

    def __init__(self, root, image=NEW):
        super().__init__(root, "backend", image)
        self.running = OLD
        self.calls = []
        self.fail_pull = False
        self.fail_start = False
        self.fail_probe = False
        self.fail_rollback = False
        self.services = "backend"

    def run(self, command, **kwargs):
        self.calls.append(command)
        if command[1] == "inspect":
            return self.running
        return "[]"

    def compose(self, config, *args, **kwargs):
        self.calls.append(args)
        image = deploy.image_in(Path(config).read_text(), "backend")
        if args == ("config", "--services"):
            return self.services
        if args == ("config", "--images"):
            return image
        if args[0] == "ps":
            return "container-id"
        if args[0] == "pull" and self.fail_pull:
            raise deploy.DeployError("Registry unavailable")
        if args[0] == "up":
            self.running = image
            if image == NEW and self.fail_start:
                raise deploy.DeployError("New container health failed")
            if image == OLD and self.fail_rollback:
                raise deploy.DeployError("Old container health failed")
        if args[0] == "exec" and self.running == NEW and self.fail_probe:
            raise deploy.DeployError("Redis connection failed")
        return ""

    def request(self, path, expected=200):
        return b'{"status":"ok"}'


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = self.root / "compose.backend.yml"
        self.config.write_text(CONFIG)
        self.deployment = FakeDeployment(self.root)

    def result(self):
        return json.loads(next((self.root / "releases").glob("*/result.json")).read_text())

    def test_success_preserves_env_and_mounts_and_records_previous_digest(self):
        self.deployment.deploy()
        self.assertEqual(self.deployment.running, NEW)
        self.assertEqual(self.config.read_text(), CONFIG.replace(OLD, NEW))
        self.assertEqual(self.result()["previousImage"], OLD)
        self.assertEqual(self.result()["status"], "success")
        self.assertTrue(any(call[0] == "exec" for call in self.deployment.calls))

    def test_pull_failure_does_not_restart_or_rewrite_current_service(self):
        self.deployment.fail_pull = True
        with self.assertRaisesRegex(deploy.DeployError, "Registry unavailable"):
            self.deployment.deploy()
        self.assertEqual(self.deployment.running, OLD)
        self.assertEqual(self.config.read_text(), CONFIG)
        self.assertFalse(any(call[0] == "up" for call in self.deployment.calls))
        self.assertEqual(self.result()["status"], "failed_before_update")

    def test_partial_start_failure_restores_old_container(self):
        self.deployment.fail_start = True
        with self.assertRaisesRegex(deploy.DeployError, "previous version restored"):
            self.deployment.deploy()
        self.assertEqual(self.deployment.running, OLD)
        self.assertEqual(self.config.read_text(), CONFIG)
        self.assertEqual(self.result()["status"], "rolled_back")

    def test_dependency_failure_after_healthy_start_triggers_rollback(self):
        self.deployment.fail_probe = True
        with self.assertRaisesRegex(deploy.DeployError, "Redis connection failed"):
            self.deployment.deploy()
        self.assertEqual(self.deployment.running, OLD)
        self.assertEqual(self.result()["status"], "rolled_back")

    def test_rollback_failure_is_reported_as_failure(self):
        self.deployment.fail_start = True
        self.deployment.fail_rollback = True
        with self.assertRaisesRegex(deploy.DeployError, "ROLLBACK FAILED"):
            self.deployment.deploy()
        self.assertEqual(self.result()["status"], "rollback_failed")

    def test_same_digest_checks_dependencies_without_pull_or_restart(self):
        self.deployment.image = OLD
        self.deployment.deploy()
        self.assertFalse(any(call[0] in ("up", "pull") for call in self.deployment.calls))
        self.assertTrue(any(call[0] == "exec" for call in self.deployment.calls))
        self.assertEqual(self.result()["status"], "unchanged")

    def test_running_image_drift_blocks_update(self):
        self.deployment.running = NEW
        with self.assertRaisesRegex(deploy.DeployError, "differs from Compose"):
            self.deployment.deploy()
        self.assertEqual(self.config.read_text(), CONFIG)

    def test_other_compose_services_cannot_be_updated(self):
        self.deployment.services = "backend\nqdrant"
        with self.assertRaisesRegex(deploy.DeployError, "service name"):
            self.deployment.deploy()
        self.assertEqual(self.config.read_text(), CONFIG)

    def test_image_validation_rejects_tags_and_wrong_repositories(self):
        for image in ["ghcr.io/bobozh/fund-backend:latest", NEW.replace("backend", "rag"),
                      NEW.replace("bobozh", "another-owner"), NEW + "; echo bad"]:
            with self.subTest(image=image), self.assertRaises(deploy.DeployError):
                deploy.validate_image("backend", image)

    def test_disk_write_failure_after_update_restores_previous_container(self):
        original_write = deploy.atomic_write

        def fail_new_config(path, content):
            if path == self.config and NEW in content:
                raise OSError("disk full")
            return original_write(path, content)

        with patch.object(deploy, "atomic_write", side_effect=fail_new_config):
            with self.assertRaisesRegex(deploy.DeployError, "previous version restored"):
                self.deployment.deploy()
        self.assertEqual(self.deployment.running, OLD)
        self.assertEqual(self.config.read_text(), CONFIG)

    def test_lock_blocks_overlapping_deployments(self):
        with deploy.deployment_lock(self.root):
            with self.assertRaisesRegex(deploy.DeployError, "Another deployment"):
                with deploy.deployment_lock(self.root, timeout=0):
                    self.fail("second deployment obtained lock")


class FrontendProbeTests(unittest.TestCase):
    def test_frontend_checks_html_and_backend_json_instead_of_accepting_any_404(self):
        frontend = deploy.Deployment("/tmp", "frontend", NEW.replace("backend", "frontend"))
        with patch.object(frontend, "request", side_effect=[
            b'{"status":"ok"}', b"<html>Login</html>", b"<html>404</html>",
        ]):
            with self.assertRaises(json.JSONDecodeError):
                frontend.probe(Path("unused"))
        with patch.object(frontend, "request", side_effect=[
            b'{"status":"ok"}', b"<html>Login</html>", b'{"status":404,"success":false}',
        ]):
            frontend.probe(Path("unused"))


if __name__ == "__main__":
    unittest.main()
