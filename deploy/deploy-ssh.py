#!/usr/bin/env python3
"""Forced SSH command for the fund deployment key. Never evaluate a shell string."""

import os
import re
import shlex
import sys


def deployment_args(command):
    try:
        args = shlex.split(command)
    except ValueError as error:
        raise ValueError("Invalid deployment command") from error
    if len(args) != 3 or args[0] != "fund-deploy":
        raise ValueError("Only fund-deploy <service> <image@sha256:digest> is allowed")
    service, image = args[1:]
    if service not in {"frontend", "backend", "rag"} or not re.fullmatch(
        rf"ghcr\.io/bobozh/fund-{re.escape(service)}@sha256:[0-9a-f]{{64}}", image
    ):
        raise ValueError("Service or image is not allowed")
    return [service, image]


def main():
    try:
        args = deployment_args(os.environ.get("SSH_ORIGINAL_COMMAND", ""))
    except ValueError as error:
        print(f"Deployment key: {error}", file=sys.stderr)
        return 1
    # Fixed executable and arguments; omit client-provided environment settings.
    os.execve(
        "/usr/bin/python3",
        ["/usr/bin/python3", "-I", "/opt/fund/scripts/deploy.py", *args],
        {"HOME": "/root", "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
         "LANG": "C.UTF-8"},
    )


if __name__ == "__main__":
    sys.exit(main())
