#!/usr/bin/env bash
# 发布到 npm：NEED 2FA 已通过 granular token 绕过，token 从环境变量读，不落盘。
set -euo pipefail
cd "$(dirname "$0")/.."
: "${NPM_TOKEN:?需要 NPM_TOKEN 环境变量（granular token，Publish 权限）}"
npm publish --access public --//registry.npmjs.org/:_authToken="$NPM_TOKEN" "$@"
