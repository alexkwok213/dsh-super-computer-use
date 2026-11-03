#!/bin/sh
# One-command install for the whole product:
#   1) native engine + /Applications/Computer Use.app + launchd agents
#   2) wire the DSH plugin (dsh-super-computer-use) into the desktop profile
set -eu
cd "$(dirname "$0")"
REPO="$(pwd)"

echo "==> 1/2 引擎：/Applications/Computer Use.app + launchd 服务"
(cd engine && ./install-app.sh)

echo
echo "==> 2/2 DSH 插件：dsh-super-computer-use"
# DSH exports DSH_PROFILE as a *name* (e.g. "desktop"), not a path.
PROFILE="${CU_DSH_PROFILE:-$HOME/.dsh/profiles/${DSH_PROFILE:-desktop}}"
if [ -f "$PROFILE/package.json" ] && grep -q '"dsh-super-computer-use"' "$PROFILE/package.json"; then
    echo "已在 ${PROFILE} 中链接本仓库；重启 DeepSeek Harness 后插件改动生效。"
elif [ -d "$PROFILE" ]; then
    cat <<EOF
在 ${PROFILE}/package.json 的 dependencies 中加入：
    "dsh-super-computer-use": "link:$REPO"
然后在 ${PROFILE} 下安装依赖并重启 DeepSeek Harness（或在 DSH 的插件页安装本地链接）。
EOF
else
    echo "未找到 DSH profile（${PROFILE}）。请在 DeepSeek Harness 的插件页安装本地路径：${REPO}"
fi

echo
echo "完成。首次安装需在「系统设置 → 隐私与安全性」给「DSH Super Computer Use」"
echo "（磁盘上为 /Applications/Computer Use.app）授予辅助功能与屏幕录制。"
