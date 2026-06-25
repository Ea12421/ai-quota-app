#!/bin/zsh
# 用机器现有的 swift(Command Line Tools)编译 + 组装成 .app,不需要装完整 Xcode。
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
APP="$DIR/build/用量看板.app"
EXE_NAME="UsageBar"

rm -rf "$DIR/build"
mkdir -p "$APP/Contents/MacOS"

# 1) 编译(列出所有 Swift 源,以后多文件直接加进来)
swiftc -O \
  -o "$APP/Contents/MacOS/$EXE_NAME" \
  "$DIR"/Sources/*.swift \
  -framework AppKit -framework WebKit

# 2) Info.plist
cp "$DIR/Info.plist" "$APP/Contents/Info.plist"

# 3) ad-hoc 签名(自用本机,无需 Apple 公证)
codesign --force --sign - "$APP" >/dev/null 2>&1 || true

echo "✅ 打包完成: $APP"
