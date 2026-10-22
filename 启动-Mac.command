#!/bin/bash
# 双击这个文件开启地图（Mac）。第一次如果提示“无法打开”：右键 → 打开
cd "$(dirname "$0")"
# 从访达双击时不会读终端的配置，常见的 Node 安装位置都加上
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.npm-global/bin:$HOME/.volta/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
if ! command -v node >/dev/null 2>&1; then
  echo
  echo "没有找到 Node.js。请到 https://nodejs.org 下载安装 LTS 版，再双击这个文件。"
  echo
  read -n 1 -s -r -p "按任意键关闭…"
  exit 1
fi
node tools/launch.mjs || { echo; read -n 1 -s -r -p "按任意键关闭…"; }
