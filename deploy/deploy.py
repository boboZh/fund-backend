#!/usr/bin/env python3
"""Update an existing /opt/fund Compose service; preserve a recoverable version."""

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request


SERVICES = {"frontend": 18080, "backend": 9000, "rag": 9001}
IMAGE_LINE = re.compile(r"^    image:[ \t]*(.+?)[ \t]*$", re.MULTILINE)

BACKEND_CHECK = r"""
const mysql = require('mysql2/promise');
const { createClient } = require('redis');
const { MYSQL_CONF } = require('./conf/db');
const fs = require('node:fs');
(async () => {
  const db = await mysql.createConnection({...MYSQL_CONF, connectTimeout: 10000});
  try { await db.query('SELECT 1'); } finally { await db.end(); }
  const redis = createClient({socket: {
    host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT || 6379),
    connectTimeout: 5000, reconnectStrategy: false,
  }});
  redis.on('error', () => {});
  await redis.connect();
  try {
    if (await redis.ping() !== 'PONG') throw new Error('Redis PING failed');
  } finally { await redis.quit(); }
  for (const url of [
    process.env.QDRANT_URL.replace(/\/$/, '') + '/collections/research_chunks',
    'http://127.0.0.1:9001/healthz',
  ]) {
    const response = await fetch(url, {signal: AbortSignal.timeout(10000)});
    if (!response.ok) throw new Error('Dependency HTTP ' + response.status);
    const body = await response.json();
    if (body.status !== 'ok') throw new Error('Dependency status is not ok');
  }
  for (const dir of ['/app/public/uploads', '/app/uploads']) {
    fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
  }
  console.log('Backend dependency checks passed');
})().catch(error => { console.error(error.message); process.exit(1); });
"""

RAG_CHECK = """
from contextlib import closing
import json
import os
import urllib.request
from app.services.store import connect
with closing(connect()) as connection:
    with connection.cursor() as cursor:
        cursor.execute('SELECT 1 AS ok')
        assert cursor.fetchone()['ok'] == 1
url = os.environ['QDRANT_URL'].rstrip('/') + '/collections/research_chunks'
with urllib.request.urlopen(url, timeout=10) as response:
    assert json.load(response)['status'] == 'ok'
print('RAG dependency checks passed')
"""


class DeployError(Exception):
    pass


def validate_image(service, image):
    if service not in SERVICES or not re.fullmatch(
        rf"ghcr\.io/bobozh/fund-{re.escape(service)}@sha256:[0-9a-f]{{64}}", image
    ):
        raise DeployError("Expected this service's ghcr.io/bobozh image and full sha256 digest")


def image_in(content, service):
    matches = IMAGE_LINE.findall(content)
    if len(matches) != 1:
        raise DeployError("Compose must contain exactly one four-space-indented image field")
    image = matches[0].strip("\"'")
    validate_image(service, image)
    return image


def replace_image(content, service, image):
    validate_image(service, image)
    image_in(content, service)
    return IMAGE_LINE.sub(lambda _: "    image: " + image, content)


def atomic_write(path, content):
    """Never leave a partially written production Compose file."""
    fd, name = tempfile.mkstemp(prefix=".deploy-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


@contextmanager
def deployment_lock(root, timeout=300):
    fd = os.open(root / ".deploy.lock", os.O_CREAT | os.O_RDWR, 0o600)
    try:
        deadline = time.monotonic() + timeout
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise DeployError("Another deployment holds /opt/fund/.deploy.lock")
                time.sleep(0.5)
        yield
    finally:
        os.close(fd)


class Deployment:
    def __init__(self, root, service, image):
        validate_image(service, image)
        self.root = Path(root)
        self.service = service
        self.image = image
        self.config = self.root / f"compose.{service}.yml"

    def run(self, command, timeout=60, input=None):
        try:
            result = subprocess.run(
                command, cwd=self.root, text=True, input=input,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout,
            )
        except subprocess.TimeoutExpired as error:
            raise DeployError(f"Command timed out after {timeout}s") from error
        if result.returncode:
            # Do not dump full Compose configuration or production environment.
            detail = (result.stdout or "")[-3000:]
            raise DeployError(f"Command failed ({result.returncode}): {detail}")
        return result.stdout.strip()

    def compose(self, config, *args, **kwargs):
        return self.run([
            "docker", "compose", "--project-directory", str(self.root),
            "-p", f"fund-{self.service}", "-f", str(config), *args,
        ], **kwargs)

    def validate_config(self, config, image):
        self.compose(config, "config", "--quiet")
        if self.compose(config, "config", "--services").splitlines() != [self.service]:
            raise DeployError("Compose service name does not match deployment target")
        if self.compose(config, "config", "--images").splitlines() != [image]:
            raise DeployError("Resolved Compose image does not match requested digest")

    def up(self, config):
        self.compose(
            config, "up", "-d", "--no-deps", "--pull", "never",
            "--wait", "--wait-timeout", "120", self.service, timeout=180,
        )

    def request(self, path, expected=200):
        url = f"http://127.0.0.1:{SERVICES[self.service]}{path}"
        try:
            response = urllib.request.urlopen(url, timeout=10)
        except urllib.error.HTTPError as error:
            if error.code != expected:
                raise DeployError(f"{path}: unexpected HTTP {error.code}") from error
            response = error
        with response:
            if response.code != expected:
                raise DeployError(f"{path}: unexpected HTTP {response.code}")
            return response.read()

    def probe(self, config):
        if json.loads(self.request("/healthz")) != {"status": "ok"}:
            raise DeployError("Unexpected health response")
        if self.service == "frontend":
            if b"<html" not in self.request("/login").lower():
                raise DeployError("SPA login route did not return HTML")
            body = json.loads(self.request("/api/__deployment_probe__", expected=404))
            if body.get("status") != 404 or body.get("success") is not False:
                raise DeployError("Frontend API proxy did not reach the backend")
        else:
            executable, script = (
                ("node", BACKEND_CHECK) if self.service == "backend" else ("python", RAG_CHECK)
            )
            self.compose(
                config, "exec", "-T", self.service, executable, "-",
                input=script, timeout=60,
            )

    def deploy(self):
        if not self.root.is_dir():
            raise DeployError("/opt/fund is not installed")
        with deployment_lock(self.root):
            return self.deploy_locked()

    def deploy_locked(self):
        original = self.config.read_text()
        old_image = image_in(original, self.service)
        self.validate_config(self.config, old_image)
        ids = self.compose(self.config, "ps", "--status", "running", "--quiet", self.service)
        if len(ids.splitlines()) != 1:
            raise DeployError("Expected one running container; recover the current service first")
        actual = self.run(["docker", "inspect", "--format", "{{.Config.Image}}", ids])
        if actual != old_image:
            raise DeployError("Running image differs from Compose; reconcile before deployment")

        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
        release = self.root / "releases" / f"{stamp}-{self.service}"
        release.mkdir(parents=True, mode=0o700)
        previous = release / "previous.compose.yml"
        candidate = release / "next.compose.yml"
        atomic_write(previous, original)
        atomic_write(candidate, replace_image(original, self.service, self.image))
        record = {"service": self.service, "previousImage": old_image,
                  "image": self.image, "timeUTC": stamp, "status": "preparing"}

        def save(status):
            record["status"] = status
            atomic_write(release / "result.json", json.dumps(record, indent=2) + "\n")

        save("preparing")
        changed = False
        try:
            self.validate_config(candidate, self.image)
            if self.image == old_image:
                self.probe(self.config)
                save("unchanged")
                print(f"{self.service}: checks passed; same digest, no restart")
                return
            # Preserve a local rollback image before touching the running service.
            self.run(["docker", "image", "inspect", old_image])
            print(f"{self.service}: pulling {self.image}", flush=True)
            self.compose(candidate, "pull", self.service, timeout=1200)
            changed = True  # up may partially replace a container before failing.
            self.up(candidate)
            self.probe(candidate)
            atomic_write(self.config, candidate.read_text())
            save("success")
            print(f"{self.service}: deployed {self.image}")
        except Exception as error:
            if not changed:
                save("failed_before_update")
                raise
            print(f"{self.service}: deployment failed; restoring {old_image}", file=sys.stderr)
            try:
                self.up(previous)
                self.probe(previous)
                atomic_write(self.config, original)
            except Exception as rollback_error:
                save("rollback_failed")
                raise DeployError(
                    f"Deployment failed: {error}; ROLLBACK FAILED: {rollback_error}. "
                    f"Recovery config: {previous}"
                ) from rollback_error
            save("rolled_back")
            raise DeployError(f"Deployment failed; previous version restored: {error}") from error


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("service", choices=SERVICES)
    parser.add_argument("image", help="full ghcr.io/bobozh/fund-<service>@sha256:... reference")
    args = parser.parse_args()
    os.umask(0o077)

    def interrupted(signum, frame):
        raise DeployError(f"Deployment interrupted by signal {signum}")

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        Deployment("/opt/fund", args.service, args.image).deploy()
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
