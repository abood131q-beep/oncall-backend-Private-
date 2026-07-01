#!/bin/bash
# ============================================================
# OnCall — إصلاح EADDRINUSE على port 3000
# ============================================================

PORT=3000
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "\n${CYAN}━━━ تشخيص port $PORT ━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

# 1. من يستخدم البورت؟
PIDS=$(lsof -ti:$PORT 2>/dev/null)

if [ -z "$PIDS" ]; then
  echo -e "  ${GREEN}✅ Port $PORT فارغ — لا مشكلة${NC}"
else
  echo -e "  ${YELLOW}⚠️  Port $PORT مشغول من العمليات التالية:${NC}"
  for PID in $PIDS; do
    INFO=$(ps -p $PID -o pid=,command= 2>/dev/null)
    echo -e "    PID $INFO"
  done

  echo -e "\n${CYAN}━━━ التحقق من نوع العملية ━━━━━━━━━━━━━━━━━━━━━${NC}"
  NODE_PIDS=$(lsof -ti:$PORT 2>/dev/null | xargs ps -p 2>/dev/null | grep -i node | awk '{print $1}')

  if [ -n "$NODE_PIDS" ]; then
    echo -e "  ${YELLOW}⚠️  عملية Node.js قديمة تشغل port $PORT — سيتم إيقافها...${NC}"
    for PID in $NODE_PIDS; do
      echo -e "  → kill -SIGTERM $PID"
      kill -SIGTERM "$PID" 2>/dev/null
    done
    sleep 2

    # تحقق هل أُوقفت
    REMAINING=$(lsof -ti:$PORT 2>/dev/null)
    if [ -n "$REMAINING" ]; then
      echo -e "  ${RED}→ لم تستجب، سيتم إجبارها: kill -9${NC}"
      kill -9 $REMAINING 2>/dev/null
      sleep 1
    fi
    echo -e "  ${GREEN}✅ تم إيقاف العملية القديمة${NC}"
  else
    echo -e "  ${RED}❌ عملية أخرى (غير Node) تشغل port $PORT${NC}"
    echo -e "  اقتراح: غيّر PORT في .env أو أوقف العملية يدوياً"
    lsof -i:$PORT
    exit 1
  fi
fi

echo -e "\n${CYAN}━━━ تشغيل السيرفر الجديد ━━━━━━━━━━━━━━━━━━━━━━${NC}"
cd "$(dirname "$0")"

# تشغيل في الخلفية مع حفظ log
node server.js > /tmp/oncall_restart.log 2>&1 &
NEW_PID=$!
echo -e "  → PID الجديد: $NEW_PID"

# انتظر حتى 8 ثوانٍ
for i in {1..8}; do
  sleep 1
  if curl -sf --max-time 1 "http://localhost:$PORT/health" > /dev/null 2>&1; then
    echo -e "  ${GREEN}✅ السيرفر يعمل بعد ${i} ثوانٍ${NC}"
    break
  fi
  if ! kill -0 "$NEW_PID" 2>/dev/null; then
    echo -e "  ${RED}❌ السيرفر توقف — سجل الأخطاء:${NC}"
    cat /tmp/oncall_restart.log
    exit 1
  fi
done

echo -e "\n${CYAN}━━━ التحقق من الـ Endpoints ━━━━━━━━━━━━━━━━━━━━━${NC}"

# /health
R=$(curl -sf --max-time 3 "http://localhost:$PORT/health" 2>/dev/null)
if echo "$R" | grep -q '"status":"ok"'; then
  UPTIME=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin)['uptime'])" 2>/dev/null)
  MEM=$(echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['memory']['used'])" 2>/dev/null)
  echo -e "  ${GREEN}✅ /health — uptime=${UPTIME}s, memory=${MEM}${NC}"
else
  echo -e "  ${RED}❌ /health لا يستجيب${NC}"
fi

# /test
R=$(curl -sf --max-time 3 "http://localhost:$PORT/test" 2>/dev/null)
if echo "$R" | grep -q '"success":true'; then
  echo -e "  ${GREEN}✅ /test — API تعمل${NC}"
else
  echo -e "  ${RED}❌ /test لا يستجيب${NC}"
fi

echo -e "\n${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "  PID النشط: $NEW_PID"
echo -e "  Log: /tmp/oncall_restart.log"
echo -e "  لإيقاف السيرفر: kill $NEW_PID"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"
