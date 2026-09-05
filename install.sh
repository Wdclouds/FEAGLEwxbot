#!/usr/bin/env bash
# ==============================================================================
# FEAGLE WxBot 全自动新手交互式安装与部署引导器 (install.sh)
# ==============================================================================
# 适用系统: Ubuntu 20.04+/Debian 11+/CentOS 8+/RHEL 9+/Arch Linux
# 运行方式: bash install.sh
# ==============================================================================
set -euo pipefail

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

print_banner() {
  echo -e "${CYAN}${BOLD}"
  echo "  ███████╗███████╗ █████╗  ██████╗ ██╗     ███████╗"
  echo "  ██╔════╝██╔════╝██╔══██╗██╔════╝ ██║     ██╔════╝"
  echo "  █████╗  █████╗  ███████║██║  ███╗██║     █████╗  "
  echo "  ██╔══╝  ██╔══╝  ██╔══██║██║   ██║██║     ██╔══╝  "
  echo "  ██║     ███████╗██║  ██║╚██████╔╝███████╗███████╗"
  echo "  ╚═╝     ╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚══════╝"
  echo "      WxBot 微信 AI 智能体生态全栈交付套件          "
  echo -e "${NC}"
}

log_info()  { echo -e "${CYAN}[FEAGLE]${NC} $*"; }
log_succ()  { echo -e "${GREEN}[✔ 成功]${NC} $*"; }
log_warn()  { echo -e "${YELLOW}[⚠ 注意]${NC} $*"; }
log_err()   { echo -e "${RED}[✖ 错误]${NC} $*"; }

check_requirements() {
  log_info "1/5 检查系统核心依赖..."
  if ! command -v docker >/dev/null 2>&1; then
    log_warn "未检测到 Docker，正在尝试自动安装 Docker..."
    curl -fsSL https://get.docker.com | bash
  fi

  if ! docker compose version >/dev/null 2>&1 && ! command -v docker-compose >/dev/null 2>&1; then
    log_err "未检测到 Docker Compose，请先安装 Docker Compose 后重试！"
    exit 1
  fi
  log_succ "Docker 与 Docker Compose 环境就绪。"
}

run_network_check() {
  log_info "2/5 进行极速国内/海外网络探测与镜像自动切换..."
  if [ -f "scripts/auto-mirror.sh" ]; then
    bash scripts/auto-mirror.sh || true
  fi
}

interactive_config() {
  log_info "3/5 智能体大脑与交互式配置..."
  if [ ! -f ".env" ]; then
    cp .env.example .env
  fi

  echo ""
  echo -e "${BOLD}请选择智能体核心大脑形态 (BOT_BACKEND):${NC}"
  echo "  [1] Hermes 深度自主思考智能体 (推荐: 长期记忆、性格画像、专属技能库)"
  echo "  [2] AstrBot 丰富社群插件生态 (推荐: 现成海量插件、小游戏、群管、自带6185后台)"
  read -rp "请输入选项 [1 或 2，默认 1]: " backend_choice
  backend_choice="${backend_choice:-1}"

  SELECTED_BACKEND="hermes"
  if [ "$backend_choice" = "2" ]; then
    SELECTED_BACKEND="astrbot"
  fi
  sed -i "s|^BOT_BACKEND=.*|BOT_BACKEND=${SELECTED_BACKEND}|" .env
  log_succ "已选择大脑形态: ${BOLD}${SELECTED_BACKEND}${NC}"

  echo ""
  echo -e "${BOLD}配置大语言模型 (LLM):${NC}"
  read -rp "请输入模型 API Base [默认 https://api.feagle.top/v1]: " input_api_base
  input_api_base="${input_api_base:-https://api.feagle.top/v1}"

  read -rp "请输入主模型名称 [默认 gemini-3.8-flash-high]: " input_model
  input_model="${input_model:-gemini-3.8-flash-high}"

  read -rp "请输入 API Key [必填或直接回车稍后修改]: " input_key
  input_key="${input_key:-replace_with_your_llm_api_key}"

  sed -i "s|^LLM_API_BASE=.*|LLM_API_BASE=${input_api_base}|" .env
  sed -i "s|^LLM_MODEL=.*|LLM_MODEL=${input_model}|" .env
  sed -i "s|^LLM_API_KEY=.*|LLM_API_KEY=${input_key}|" .env

  # 生成 32 位随机 Token（若尚未配置）
  CURRENT_TOKEN=$(grep '^ANDROID_BRIDGE_TOKEN=' .env | cut -d '=' -f2- || true)
  if [ -z "$CURRENT_TOKEN" ] || [ "$CURRENT_TOKEN" = "replace_with_a_secure_random_token_32_chars_min" ]; then
    RANDOM_TOKEN=$(openssl rand -hex 16 2>/dev/null || python3 -c 'import secrets; print(secrets.token_hex(16))')
    sed -i "s|^ANDROID_BRIDGE_TOKEN=.*|ANDROID_BRIDGE_TOKEN=${RANDOM_TOKEN}|" .env
    log_succ "已为您自动生成高强度设备连接密钥 Token: ${RANDOM_TOKEN:0:8}****"
  fi
}

start_services() {
  log_info "4/5 启动并编排容器服务栈..."
  mkdir -p data/wechat data/astrbot data/mnemosyne-db

  COMPOSE_PROFILE="$SELECTED_BACKEND"
  log_info "拉起 Docker Profile: [${COMPOSE_PROFILE}] + bridge ..."
  docker compose --profile "$COMPOSE_PROFILE" up -d --build
}

health_check_and_summary() {
  log_info "5/5 等待服务健康就绪检查..."
  sleep 3

  PUBLIC_IP=$(curl -fsSL -m 3 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
  DASHBOARD_PORT=$(grep '^DASHBOARD_HOST_PORT=' .env | cut -d '=' -f2- || echo "6190")

  echo ""
  echo -e "${GREEN}${BOLD}======================================================================${NC}"
  echo -e "${GREEN}${BOLD}              🎉 FEAGLE WxBot 全栈服务已成功启动！                     ${NC}"
  echo -e "${GREEN}${BOLD}======================================================================${NC}"
  echo -e "  🌐 Web 控制台访问:   ${BOLD}http://${PUBLIC_IP}:${DASHBOARD_PORT}${NC}"
  echo -e "  📱 平板端无感配对:   在电脑浏览器打开控制台，点击右上角【连接设备】扫码即可免密配对！"
  if [ "$SELECTED_BACKEND" = "astrbot" ]; then
    echo -e "  🧩 AstrBot 插件后台: http://${PUBLIC_IP}:6185 (账号密码请查看终端日志)"
  fi
  echo -e "  📄 查看实时运行日志: docker compose logs -f bridge"
  echo -e "  🛑 停止所有服务:     docker compose --profile ${SELECTED_BACKEND} down"
  echo -e "${GREEN}${BOLD}======================================================================${NC}"
}

main() {
  print_banner
  check_requirements
  run_network_check
  interactive_config
  start_services
  health_check_and_summary
}

main "$@"
