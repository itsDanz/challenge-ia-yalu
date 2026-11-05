#!/usr/bin/env bash
# Supervisor del bot del torneo: lo relanza 1 s después si el proceso termina por cualquier motivo
# (el árbitro nos da por ausentes a los 30 s). En macOS, `caffeinate` mantiene la laptop despierta
# mientras viva el supervisor. Lee .env igual que `npm start`. Ctrl+C detiene el bot y el supervisor.
#
#   npm run torneo        (o directamente: scripts/run-bot.sh)
set -u
cd "$(dirname "$0")/.." || exit 1

if command -v caffeinate >/dev/null 2>&1; then
  caffeinate -i -w $$ & # termina solo cuando termina este script
fi

stop=0
pid=""
# Los hijos en segundo plano de un script ignoran SIGINT, así que se les reenvía SIGTERM,
# que start.ts maneja con un cierre ordenado.
trap 'stop=1; [ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null' INT TERM

restarts=0
while [ "$stop" -eq 0 ]; do
  node src/cli/start.ts &
  pid=$!
  wait "$pid"
  code=$?
  if [ "$stop" -eq 1 ]; then
    wait "$pid" 2>/dev/null
    break
  fi
  restarts=$((restarts + 1))
  echo "$(date '+%H:%M:%S') supervisor: el bot terminó con código $code; reinicio #$restarts en 1 s" >&2
  sleep 1
done
echo "supervisor: detenido después de $restarts reinicios" >&2
