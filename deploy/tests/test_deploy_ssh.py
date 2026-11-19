import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("fund_deploy_ssh", Path(__file__).parents[1] / "deploy-ssh.py")
entry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(entry)


class RestrictedKeyTests(unittest.TestCase):
    def test_accepts_only_matching_service_and_digest(self):
        for service in ["frontend", "backend", "rag"]:
            image = f"ghcr.io/bobozh/fund-{service}@sha256:" + "a" * 64
            self.assertEqual(entry.deployment_args(f"fund-deploy {service} {image}\n"), [service, image])

    def test_rejects_shell_and_injection(self):
        image = "ghcr.io/bobozh/fund-rag@sha256:" + "a" * 64
        commands = ["", "bash", "whoami", "sftp", "scp -t /tmp/file", "docker ps",
                    f"fund-deploy rag {image}; id", f"fund-deploy rag {image} && id",
                    f"fund-deploy rag $(id)", f"fund-deploy rag {image}\nwhoami",
                    f"fund-deploy backend {image}", "fund-deploy rag ghcr.io/bobozh/fund-rag:latest",
                    "fund-deploy rag 'unterminated"]
        for command in commands:
            with self.subTest(command=command), self.assertRaises(ValueError):
                entry.deployment_args(command)

    def test_executes_fixed_program_without_untrusted_environment(self):
        image = "ghcr.io/bobozh/fund-rag@sha256:" + "a" * 64
        with patch.dict(entry.os.environ, {"SSH_ORIGINAL_COMMAND": f"fund-deploy rag {image}",
                                          "PYTHONPATH": "/tmp/untrusted", "DOCKER_HOST": "tcp://bad"}):
            with patch.object(entry.os, "execve") as execute:
                entry.main()
        executable, args, environment = execute.call_args.args
        self.assertEqual(executable, "/usr/bin/python3")
        self.assertEqual(args, [executable, "-I", "/opt/fund/scripts/deploy.py", "rag", image])
        self.assertNotIn("PYTHONPATH", environment)
        self.assertNotIn("DOCKER_HOST", environment)
        self.assertEqual(environment["HOME"], "/root")


if __name__ == "__main__":
    unittest.main()
